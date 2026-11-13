"""Closed host-domain data, not proof of capture, consent, liveness or identity."""
import hashlib
import json
import unicodedata

from .errors import JournalError, require
from .schema import SAFE


def integer(value, low=0, high=SAFE):
    require(type(value) is int and low <= value <= high)
    return value


def text(value, limit, identifier=False):
    require(type(value) is str and bool(value))
    try:
        require(len(value.encode('utf-8')) <= limit)
    except UnicodeError:
        raise JournalError('journal_invalid') from None
    if identifier:
        require(all(c.isprintable() and not c.isspace() for c in value))
    return value


def hexid(value, size=64):
    text(value, size, True)
    require(len(value) == size and all(c in '0123456789abcdef' for c in value))
    return value


def closed(value, keys):
    require(type(value) is dict and set(value) == set(keys.split()))
    return value


def canonical(value):
    try:
        result = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        result.encode('utf-8')
        return result
    except (ValueError, TypeError, UnicodeError):
        raise JournalError('journal_invalid') from None


def digest(encoded):
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def _pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def _invalid(_):
    raise JournalError('journal_invalid')


def unpack(encoded, limit):
    text(encoded, limit)
    try:
        value = json.loads(encoded, object_pairs_hook=_pairs, parse_float=_invalid, parse_constant=_invalid)
    except (ValueError, RecursionError):
        raise JournalError('journal_invalid') from None
    require(canonical(value) == encoded)
    return value


def context(value):
    closed(value, 'profileId launchId attachmentId ownerSubject authorityEpoch connectionGeneration policyDigest')
    require(value['profileId'] == 'ivy')
    hexid(value['launchId'], 32)
    hexid(value['attachmentId'])
    text(value['ownerSubject'], 512, True)
    integer(value['authorityEpoch'])
    integer(value['connectionGeneration'], 1)
    hexid(value['policyDigest'])
    return value


def prepared(value, created_ms):
    require(unicodedata.unidata_version == '16.0.0', 'unicode_mismatch')
    closed(value, 'version challengeId connectionBinding origin displayScope expiresAt maxAdmissions challengeExpiresAt')
    require(type(value['version']) is int and value['version'] == 1)
    hexid(value['challengeId'])
    hexid(value['connectionBinding'])
    origin = closed(value['origin'], 'profileId sessionId physicalTarget route producerId workerIncarnation')
    for field in ('profileId', 'sessionId', 'physicalTarget', 'route', 'producerId'):
        text(origin[field], 512, True)
    require(origin['profileId'] == 'ivy' and origin['producerId'] == 'stellar-herdr')
    hexid(origin['workerIncarnation'], 32)
    view = closed(value['displayScope'], 'profileLabel conversationLabel producerLabel effects')
    for field in ('profileLabel', 'conversationLabel', 'producerLabel'):
        text(view[field], 256)
        require(view[field].strip() and all(unicodedata.category(c) != 'Cc' for c in view[field]))
    require(type(view['effects']) is list and view['effects'] == ['render', 'speech'])
    integer(created_ms)
    integer(value['maxAdmissions'], 1, 100)
    integer(value['challengeExpiresAt'], created_ms + 1, min(SAFE, created_ms + 60000))
    integer(value['expiresAt'], value['challengeExpiresAt'], min(SAFE, created_ms + 604800000))
    return value


def pack_context(value):
    encoded = canonical(context(value))
    text(encoded, 8192)
    return encoded, digest(encoded)


def pack_prepared(value, created_ms):
    encoded = canonical(prepared(value, created_ms))
    text(encoded, 16384)
    return encoded, digest(encoded)
