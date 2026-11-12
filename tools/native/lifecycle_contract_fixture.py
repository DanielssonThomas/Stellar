"""Generate a deterministic descriptor with the producer's pure contract module.

No Hermes import, registration, session, credential or network operation occurs.
Canonical receipt bytes are synthetic consumer fixtures, not delivery evidence.
"""
import argparse
from dataclasses import asdict
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unicodedata

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--producer', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--identifier-policy-output', type=Path)
args = parser.parse_args()
sys.dont_write_bytecode = True
base = args.producer / 'config/hermes-compat/stellar-background-v1'
source = base / 'stellar_background/contract.py'
if (hashlib.sha256(source.read_bytes()).hexdigest() != '7d79ef58d7585477a4c220f450efe082bea1fa30e99063ff6958cb75e6d563a2'
        or hashlib.sha256((base / 'contract-v1.json').read_bytes()).hexdigest()
        != '008c72c917a981672e4ff5e08e54780484c784169cf91d2757fc62dc283ec724'):
    raise SystemExit('Producer checkpoint mismatch; refusing to execute an unreviewed contract.')
spec = importlib.util.spec_from_file_location('_stellar_contract_fixture', source)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
now = 1700000000000
origin = module.Origin('D:\\Hermes\\profiles\\ivy', 'session', 'physical', 'fixture-route',
                       'stellar-herdr', 'a' * 32).validate()
binding = {'bindingId': '1' * 32, 'origin': asdict(origin), 'consentRevision': 1,
           'expiresAt': now + 600000, 'maxAdmissions': 100, 'spent': 1,
           'revoked': False, 'createdAt': now}
event = {'schemaVersion': 1, 'eventId': 'event-é', 'kind': 'lifecycle_update',
         'payload': {'milestone': 'waiting_review', 'fact': {'note': 'é\nsource fact'}, 'observedAt': now}}
card = module.descriptor(binding, event, module.event_digest(binding, event))
inspection = {'schemaVersion': 1, 'descriptor': card, 'status': 'terminal',
              'retryAuthorized': False, 'deliveryAuthorized': True, 'receipt': {
                  'admission_id': 'lifecycle-admission', 'ref': {'profile_id': origin.profileId,
                  'session_id': origin.sessionId}, 'status': 'terminal', 'outcome': 'completed',
                  'sequence': 4, 'authority_epoch': 2, 'execution_generation': 7,
                  'result': {'final_response': 'Verified fixture answer, not live evidence.'}}}
document = {'producerCheckpoint': 'ba49247c92461ccb05aed1a6d3048676ac1d78ee',
            'contractSha256': hashlib.sha256((base / 'contract-v1.json').read_bytes()).hexdigest(),
            'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'now': now, 'binding': binding, 'event': event, 'inspection': inspection}
args.output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
if args.identifier_policy_output:
    ranges = []
    start = None
    for value in range(0x110000):
        if not chr(value).isprintable():
            if start is None: start = value
        elif start is not None:
            ranges.append([start, value - 1]); start = None
    if start is not None: ranges.append([start, 0x10ffff])
    args.identifier_policy_output.write_text(json.dumps({'unicodeVersion': unicodedata.unidata_version,
        'nonPrintableRanges': ranges}, separators=(',', ':')) + '\n', encoding='utf-8')
print('Generated producer-derived descriptor and synthetic canonical receipt fixture.')
