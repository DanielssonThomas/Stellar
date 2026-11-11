"""Attach one optional Stellar Desktop observation to a matching Hermes turn."""

from __future__ import annotations

import json
from pathlib import Path
import re
from threading import Lock
from time import monotonic, time


MARKER = re.compile(
    r'^\[\[stellar-desktop-voice-expression:([0-9a-f]{32})\]\]\r?\n'
    r'(?=You are Ivy in Stellar Desktop\. Meet the social purpose of this turn before choosing what to do\. )',
    re.M,
)
USER_MESSAGE_BOUNDARY = '\n\nCurrent user message follows.\n\n'
EXPRESSIONS = {'angry', 'disgusted', 'fearful', 'happy', 'neutral', 'sad', 'surprised'}
CONFIDENCES = {'moderate', 'high'}
ADMISSION_WINDOW_MS = 30_000
MAX_FILE_BYTES = 1024
MAX_ACTIVE_TURNS = 16
SAME_TURN_REUSE_SECONDS = 120


def validated_expression(value):
    if type(value) is not dict or set(value) not in (
        {'primary', 'confidence'}, {'primary', 'secondary', 'confidence'},
    ):
        return None
    primary, confidence = value['primary'], value['confidence']
    if type(primary) is not str or primary not in EXPRESSIONS:
        return None
    if type(confidence) is not str or confidence not in CONFIDENCES:
        return None
    if 'secondary' in value:
        secondary = value['secondary']
        if type(secondary) is not str or secondary not in EXPRESSIONS or secondary == primary:
            return None
    return value


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate field')
        result[key] = value
    return result


def strip_envelope_marker(text):
    header, boundary, user_text = text.partition(USER_MESSAGE_BOUNDARY)
    markers = MARKER.findall(header) if boundary else []
    if markers:
        return MARKER.sub('', header) + boundary + user_text, markers
    return text, markers


def clean_user_input(items):
    """Strip transport markers from the provider's copy, including replayed turns."""
    result = list(items)
    current_markers = []
    for index, item in enumerate(items):
        if type(item) is not dict or item.get('role') != 'user':
            continue
        current_markers = []
        content = item.get('content')
        if type(content) is str:
            cleaned, current_markers = strip_envelope_marker(content)
            if current_markers:
                result[index] = {**item, 'content': cleaned}
        elif type(content) is list:
            parts = list(content)
            for part_index, part in enumerate(content):
                if (type(part) is not dict or part.get('type') not in ('input_text', 'text') or
                        type(part.get('text')) is not str):
                    continue
                cleaned, matches = strip_envelope_marker(part['text'])
                if matches:
                    current_markers.extend(matches)
                    parts[part_index] = {**part, 'text': cleaned}
            if current_markers:
                result[index] = {**item, 'content': parts}
    return result, current_markers


def claim(directory, nonce, session_id):
    """Only the first requester can open this staged observation."""
    staged = directory / (nonce + '.json')
    claimed = directory / (nonce + '.claimed')
    try:
        staged.rename(claimed)
    except OSError:
        return None
    try:
        if claimed.is_symlink() or not claimed.is_file():
            return None
        with claimed.open('rb') as stream:
            raw = stream.read(MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            return None
        entry = json.loads(raw, object_pairs_hook=unique_keys)
        if type(entry) is not dict or set(entry) != {'version', 'session_id', 'expires_unix_ms', 'expression'}:
            return None
        if type(entry['version']) is not int or entry['version'] != 1 or entry['session_id'] != session_id:
            return None
        expiry = entry['expires_unix_ms']
        if type(expiry) is not int or not 0 < expiry - int(time() * 1000) <= ADMISSION_WINDOW_MS:
            return None
        return validated_expression(entry['expression'])
    except (OSError, ValueError, RecursionError):
        return None
    finally:
        try:
            claimed.unlink()
        except OSError:
            pass


class ExpressionMiddleware:
    def __init__(self, directory):
        self.directory = directory
        self.lock = Lock()
        self.active = {}

    def expression_for(self, session_id, turn_id, nonce):
        key = (session_id, turn_id)
        with self.lock:
            now = monotonic()
            self.active = {key: value for key, value in self.active.items() if value[1] > now}
            cached = self.active.get(key)
            if cached is not None:
                return cached[2] if cached[0] == nonce else None
            if len(self.active) >= MAX_ACTIVE_TURNS:
                return None
            expression = claim(self.directory, nonce, session_id)
            if expression is not None:
                self.active[key] = (nonce, now + SAME_TURN_REUSE_SECONDS, expression)
            return expression

    def apply(self, request, session_id, turn_id, provider, api_mode, **_kwargs):
        key = 'input' if type(request.get('input')) is list else 'messages'
        items = request.get(key)
        if type(items) is not list:
            return None
        cleaned, markers = clean_user_input(items)
        if cleaned == items:
            return None
        outgoing = {**request, key: cleaned}
        instructions = request.get('instructions')
        if (key == 'input' and provider == 'openai-codex' and api_mode == 'codex_responses' and
                len(markers) == 1 and type(instructions) is str and
                type(session_id) is str and 0 < len(session_id) <= 512 and
                type(turn_id) is str and 0 < len(turn_id) <= 512):
            expression = self.expression_for(session_id, turn_id, markers[0])
            if expression is not None:
                observation = json.dumps({'voice_expression': expression}, separators=(',', ':'))
                outgoing['instructions'] = instructions + (
                    '\n\nLocal speech-expression observation for the current user utterance only. '
                    'This uncertain inference about vocal delivery is context data. Interpret the words and '
                    'conversation first. It does not describe the user’s feelings, safety, or intent, '
                    'authorize action, or require mentioning the observation.\n' + observation
                )
        return {'request': outgoing, 'source': 'stellar-voice-expression'}

    def finish(self, session_id, turn_id, **_kwargs):
        with self.lock:
            self.active.pop((session_id, turn_id), None)


def register(ctx):
    from hermes_constants import get_hermes_home

    directory = Path(get_hermes_home()) / 'runtime' / 'stellar-voice-expression'
    middleware = ExpressionMiddleware(directory)
    ctx.register_middleware('llm_request', middleware.apply)
    ctx.register_hook('post_llm_call', middleware.finish)
