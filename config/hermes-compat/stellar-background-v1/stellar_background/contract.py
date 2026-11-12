"""Closed host-owned v1 envelopes. Outside source facts remain data, never permission."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import re

CAPABILITY = 'stellar.background.v1'
MAX_EVENT_BYTES = 256
MAX_ENVELOPE_BYTES = 16_384
MAX_RESULT_BYTES = 262_144
MAX_PENDING = 16
MAX_ADMISSIONS = 100
MAX_BINDINGS = 20  # retained bindings, including revoked/expired; never evict a replay fence
MAX_CONSENT_MS = 7 * 86400 * 1000
EVENT_FRESHNESS_MS = 300_000
RETRY_DELAYS = (1, 2, 4, 8, 16, 30, 30)  # eight attempts INCLUDING the first
MILESTONES = frozenset(('worker_exited', 'worker_blocked', 'waiting_review', 'checks_failed',
                        'checks_passed', 'merged', 'workflow_verified'))
HEX = re.compile(r'[0-9a-f]{64}')


class ContractError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def text(value, limit, *, identifier=False):
    if type(value) is not str or not value or (identifier and any(not c.isprintable() or c.isspace() for c in value)):
        raise ContractError('invalid_params')
    try:
        size = len(value.encode('utf-8', errors='strict'))
    except UnicodeError:
        raise ContractError('invalid_params') from None
    if size > limit:
        raise ContractError('invalid_params')
    return value


def integer(value, low=0, high=2**53 - 1):
    if type(value) is not int or not low <= value <= high:
        raise ContractError('invalid_params')
    return value


def closed(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ContractError('invalid_params')
    return value


def _json_value(value, depth=0, count=None):
    count = [0] if count is None else count
    count[0] += 1
    if depth > 8 or count[0] > 256:
        raise ContractError('invalid_params')
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        integer(value, -(2**53 - 1))
    elif type(value) is str:
        if value:
            text(value, MAX_ENVELOPE_BYTES)
    elif type(value) is list:
        for item in value:
            _json_value(item, depth + 1, count)
    elif type(value) is dict:
        for key, item in value.items():
            if type(key) is not str or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', key):
                raise ContractError('invalid_params')
            _json_value(item, depth + 1, count)
    else:
        raise ContractError('invalid_params')


def canonical(value):
    _json_value(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


@dataclass(frozen=True)
class Origin:
    """Host-only capture result; never deserialize this type from plugin/model request arguments."""
    profileId: str
    sessionId: str
    physicalTarget: str
    route: str
    producerId: str
    workerIncarnation: str

    def validate(self):
        for value in asdict(self).values():
            text(value, 512, identifier=True)
        if not re.fullmatch(r'[0-9a-f]{32}', self.workerIncarnation):
            raise ContractError('invalid_params')
        return self


def event_digest(binding, event):
    closed(event, ('schemaVersion', 'eventId', 'kind', 'payload'))
    if type(event['schemaVersion']) is not int or event['schemaVersion'] != 1 or event['kind'] != 'lifecycle_update':
        raise ContractError('invalid_params')
    text(event['eventId'], MAX_EVENT_BYTES, identifier=True)
    payload = closed(event['payload'], ('milestone', 'fact', 'observedAt'))
    if type(payload['milestone']) is not str or payload['milestone'] not in MILESTONES:
        raise ContractError('invalid_params')
    integer(payload['observedAt'])
    document = {'schemaVersion': 1, 'bindingId': binding['bindingId'],
        'origin': binding['origin'], 'consentRevision': binding['consentRevision'],
        'expiresAt': binding['expiresAt'], 'maxAdmissions': binding['maxAdmissions'], **event}
    encoded = canonical(document).encode('utf-8')
    if len(encoded) > MAX_ENVELOPE_BYTES:
        raise ContractError('invalid_params')
    return hashlib.sha256(encoded).hexdigest()


def descriptor(binding, event, digest):
    return {'schemaVersion': 1, 'capability': CAPABILITY, 'kind': 'lifecycle_update',
        'bindingId': binding['bindingId'], 'eventId': event['eventId'], 'digest': digest,
        'origin': binding['origin'], 'consentRevision': binding['consentRevision'],
        'expiresAt': binding['expiresAt'], 'maxAdmissions': binding['maxAdmissions'],
        'eventExpiresAt': min(binding['expiresAt'], event['payload']['observedAt'] + EVENT_FRESHNESS_MS)}


def retry_delay(attempts, *, guaranteed_not_admitted, now, expires_at):
    integer(attempts, 1, 8)
    if guaranteed_not_admitted is not True or attempts == 8:
        return None
    delay = RETRY_DELAYS[attempts - 1]
    return delay if now + delay * 1000 < expires_at else None
