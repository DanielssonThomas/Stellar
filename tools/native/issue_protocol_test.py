import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('workspace_protocol', ROOT / 'apps/stellar-desktop/src-tauri/src/ivy/workspace_protocol.py')
assert spec is not None and spec.loader is not None
workspace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workspace)
FIXTURES = json.loads((ROOT / 'tools/native/fixtures/workspace-issue.json').read_text(encoding='utf-8'))


def operation(value):
    return {'kind': 'open', 'instance_id': 'issue', 'surface': 'github-issue', 'prominence': 'primary', 'payload_json': json.dumps(value)}


def scores(value):
    show = {'kind': 'show', 'panel': {'detail': {'surface': 'github-issue', 'payload': value}}}
    return [{'prepare': [show]}, {'segments': [{'actions': [show]}]}, {'segments': [{'after': [show]}]}]


class IssueProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_shared_raw_semantics_hidden_parents_and_escaped_keys(self):
        fixtures = json.loads((ROOT / 'tools/native/fixtures/workspace-issue-duplicates.json').read_text(encoding='utf-8'))
        cases = [(fixtures['valid_payload_json'], True)] + [(case['payload_json'], False) for case in fixtures['semantic_invalid']]
        for raw, valid in cases:
            for wrapper in fixtures['spatial_wrappers']:
                score = wrapper['prefix'] + raw + wrapper['suffix']
                for score in (score, score.replace('"surface"', '"surfac\\u0065"', 1)):
                    with self.subTest(route=wrapper['name'], valid=valid):
                        if valid:
                            workspace.validate_operation({'kind': 'present', 'score_json': score})
                        else:
                            with self.assertRaises(workspace.WorkspaceRefused):
                                workspace.validate_operation({'kind': 'present', 'score_json': score})
                        for key in ('hidden_suffix', 'hidden_escaped_suffix'):
                            with self.assertRaises(workspace.WorkspaceRefused):
                                workspace.validate_operation({'kind': 'present', 'score_json': score[:-1] + wrapper[key]})

    def test_same_raw_duplicate_bytes_at_direct_content_and_all_spatial_boundaries(self):
        fixtures = json.loads((ROOT / 'tools/native/fixtures/workspace-issue-duplicates.json').read_text(encoding='utf-8'))
        cases = [('valid', fixtures['valid_payload_json'], True)] + [(case['name'], case['payload_json'], False) for case in fixtures['invalid']]
        for name, raw, valid in cases:
            operations = [
                {**operation(None), 'payload_json': raw},
                {'kind': 'update', 'instance_id': 'issue', 'surface': 'github-issue', 'payload_json': raw, 'expected_revision': 0},
            ]
            operations.extend({'kind': 'present', 'score_json': wrapper['prefix'] + raw + wrapper['suffix']} for wrapper in fixtures['spatial_wrappers'])
            for entry in operations:
                with self.subTest(name=name, kind=entry['kind']):
                    if valid:
                        self.assertEqual(workspace.validate_operation(entry), entry)
                    else:
                        with self.assertRaises(workspace.WorkspaceRefused):
                            workspace.validate_operation(entry)
            content = {'kind': 'content', 'instance_id': 'issue', 'surface': 'github-issue', 'revision': 0, 'payload_json': raw}
            with self.subTest(name=name, kind='content'):
                if valid:
                    self.assertEqual(workspace.validate_outcome(content, 'inspect_content'), content)
                else:
                    with self.assertRaises(workspace.WorkspaceRefused):
                        workspace.validate_outcome(content, 'inspect_content')

    def test_shared_valid_and_malformed_direct_and_spatial_payloads(self):
        valid = FIXTURES['valid']
        self.assertEqual(workspace.validate_operation(operation(valid)), operation(valid))
        for score in scores(valid):
            workspace.validate_operation({'kind': 'present', 'score_json': json.dumps(score)})
        for case in FIXTURES['invalid']:
            value = copy.deepcopy(valid)
            parent = value
            for key in case['path'][:-1]:
                parent = parent[key]
            parent[case['path'][-1]] = case['value']
            with self.subTest(case=case), self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation(operation(value))
            for score in scores(value):
                with self.subTest(case=case), self.assertRaises(workspace.WorkspaceRefused):
                    workspace.validate_operation({'kind': 'present', 'score_json': json.dumps(score)})

    def test_nullable_fields_states_unicode_and_size(self):
        value = copy.deepcopy(FIXTURES['valid'])
        for key in ['description', 'workflow_status', 'labels', 'owner', 'blockers', 'pull_requests']:
            value['issue'][key] = None
            missing = copy.deepcopy(value)
            del missing['issue'][key]
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation(operation(missing))
        workspace.validate_operation(operation(value))
        for status in ['loading', 'unavailable', 'error']:
            workspace.validate_operation(operation({**value, 'status': status, 'issue': None, 'observed_at_ms': None}))
        for title in ['é' * 121, '\ud800']:
            with self.assertRaises(workspace.WorkspaceRefused):
                workspace.validate_operation(operation({**value, 'title': title}))
        with self.assertRaises(workspace.WorkspaceRefused):
            workspace.validate_operation({**operation(value), 'payload_json': ' ' * 16385})

    async def test_issue_payload_cannot_escape_turn_fencing(self):
        frames = []
        gate = workspace.WorkspaceGate(frames.append)
        token = gate.arm('1', 'turn')
        task = asyncio.create_task(gate.call(operation(FIXTURES['valid']), token))
        await asyncio.sleep(0)
        header = {key: frames[0]['data'][key] for key in ('version', 'request_id', 'epoch', 'turn_id')}
        with self.assertRaises(workspace.WorkspaceRefused):
            gate.reply({**header, 'epoch': '2', 'outcome': {'kind': 'applied'}})
        gate.disarm()
        with self.assertRaises(workspace.WorkspaceRefused):
            await task
        with self.assertRaises(workspace.WorkspaceRefused):
            gate.reply({**header, 'outcome': {'kind': 'applied'}})


if __name__ == '__main__':
    unittest.main()
