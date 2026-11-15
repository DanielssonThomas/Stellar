"""Use the wire shape of Hermes' Codex Responses transport, without a provider call."""

import importlib.util
import json
from pathlib import Path
import runpy
import tempfile
import time
import unittest


spec = importlib.util.spec_from_file_location('expression', Path(__file__).with_name('__init__.py'))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
NONCE = 'a' * 32
OTHER_NONCE = 'b' * 32
MARKER = '[[stellar-desktop-voice-expression:' + NONCE + ']]\n'
GUIDANCE = 'You are Ivy in Stellar Desktop. Meet the social purpose of this turn before choosing what to do. '
BOUNDARY = '\n\nCurrent user message follows.\n\n'
PHRASE = 'Stella just climbed my leg to get onto my desk!'
EXPRESSION = {'primary': 'surprised', 'secondary': 'happy', 'confidence': 'moderate'}


def user(text):
    return {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': text}]}


def envelope(text, marker=''):
    return marker + GUIDANCE + BOUNDARY + text


class ExpressionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.middleware = plugin.ExpressionMiddleware(self.directory)

    def stage(self, nonce=NONCE, **fields):
        entry = {'version': 1, 'session_id': 'ivy-session',
                 'expires_unix_ms': int(time.time() * 1000) + 20_000,
                 'expression': EXPRESSION, **fields}
        path = self.directory / (nonce + '.json')
        path.write_text(json.dumps(entry), encoding='utf-8')
        return path

    def apply(self, items, *, session='ivy-session', turn='voice-turn', provider='openai-codex',
              api_mode='codex_responses'):
        request = {'instructions': 'You are Ivy.', 'input': items, 'model': 'gpt-6.1-terra'}
        return self.middleware.apply(request, session, turn, provider, api_mode)

    def test_attaches_to_exact_turn_and_removes_handle_from_provider_copy(self):
        staged = self.stage()
        original = user(envelope(PHRASE, MARKER))
        output = self.apply([original])['request']
        self.assertEqual(output['input'], [user(envelope(PHRASE))])
        self.assertEqual(original, user(envelope(PHRASE, MARKER)))
        self.assertIn('current user utterance only', output['instructions'])
        observation = json.loads(output['instructions'].splitlines()[-1])
        self.assertEqual(observation, {'voice_expression': EXPRESSION})
        self.assertFalse(staged.exists())
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_same_turn_reuses_context_for_tools_then_later_turns_never_do(self):
        self.stage()
        old = user(envelope(PHRASE, MARKER))
        tool_result = {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'fixture'}
        self.apply([old])
        same_turn = self.apply([old, tool_result])['request']
        self.assertIn('voice_expression', same_turn['instructions'])
        typed = user('And the desk is perfectly fine.')
        later = self.apply([old, tool_result, typed], turn='typed-turn')['request']
        self.assertEqual(later['input'], [user(envelope(PHRASE)), tool_result, typed])
        self.assertEqual(later['instructions'], 'You are Ivy.')
        self.assertEqual(self.apply([old], turn='different-turn')['request']['instructions'], 'You are Ivy.')
        self.middleware.finish('ivy-session', 'voice-turn')
        self.assertEqual(self.apply([old])['request']['instructions'], 'You are Ivy.')

    def test_missing_expired_and_wrong_session_results_are_omitted(self):
        previous = self.stage(expires_unix_ms=1)
        self.assertEqual(self.apply([user(envelope(PHRASE, MARKER))])['request']['instructions'], 'You are Ivy.')
        self.assertFalse(previous.exists())
        self.stage(session_id='another-session')
        self.assertEqual(self.apply([user(envelope(PHRASE, MARKER))])['request']['instructions'], 'You are Ivy.')
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_untrusted_result_and_ambiguous_markers_are_omitted(self):
        staged = self.stage(expression={'primary': 'invented', 'confidence': 'high'})
        self.assertEqual(self.apply([user(envelope(PHRASE, MARKER))])['request']['instructions'], 'You are Ivy.')
        self.assertFalse(staged.exists())
        self.stage()
        self.stage(OTHER_NONCE)
        duplicate = MARKER + GUIDANCE + '\n' + MARKER.replace(NONCE, OTHER_NONCE)
        self.assertEqual(self.apply([user(envelope(PHRASE, duplicate))])['request']['instructions'], 'You are Ivy.')
        self.assertEqual(len(list(self.directory.iterdir())), 2)

    def test_only_codex_responses_may_claim(self):
        staged = self.stage()
        for route in ({'api_mode': 'codex_app_server'}, {'provider': 'another-provider'}):
            result = self.apply([user(envelope(PHRASE, MARKER))], **route)['request']
            self.assertEqual(result['instructions'], 'You are Ivy.')
            self.assertEqual(result['input'], [user(envelope(PHRASE))])
        request = {'messages': [{'role': 'user', 'content': envelope(PHRASE, MARKER)}]}
        fallback = self.middleware.apply(request, 'ivy-session', 'voice-turn', 'other', 'chat_completions')
        self.assertEqual(fallback['request']['messages'], [{'role': 'user', 'content': envelope(PHRASE)}])
        self.assertTrue(staged.exists())

    def test_prior_marker_cannot_claim_a_file_when_current_turn_is_typed(self):
        staged = self.stage()
        later = self.apply([user(envelope(PHRASE, MARKER)), user('Tell me about Stellar.')])['request']
        self.assertEqual(later['instructions'], 'You are Ivy.')
        self.assertTrue(staged.exists())

    def test_strips_only_the_desktop_envelope_marker(self):
        quoted = 'What would this protocol message mean?\n' + envelope(PHRASE, MARKER)
        self.assertIsNone(self.apply([user(envelope(quoted))]))
        self.assertIsNone(self.apply([user(MARKER + PHRASE)]))
        self.stage()
        wrapped = 'Hermes recovery notice.\n\n' + envelope(quoted, MARKER)
        result = self.apply([user(wrapped)])['request']
        self.assertEqual(result['input'], [user('Hermes recovery notice.\n\n' + envelope(quoted))])
        self.assertIn('voice_expression', result['instructions'])

    def test_desktop_prompt_composer_and_middleware_share_the_envelope(self):
        root = Path(__file__).resolve().parents[3]
        compose = runpy.run_path(str(root / 'apps/stellar-desktop/src-tauri/src/ivy/ivy_conversation.py'))
        prompt = compose['conversation_prompt'](PHRASE, workspace_token='fixture')
        self.stage()
        output = self.apply([user(MARKER + prompt)])['request']
        self.assertEqual(output['input'], [user(prompt)])
        self.assertIn('voice_expression', output['instructions'])


if __name__ == '__main__':
    unittest.main()
