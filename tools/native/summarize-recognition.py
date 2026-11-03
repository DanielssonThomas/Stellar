"""Summarize actual coordinator actions, with misses, duplicates and fallback exposed."""
import argparse
import importlib.util
import json
from pathlib import Path
import statistics
import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fixtures', type=Path, required=True)
parser.add_argument('--replay', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('h', Path(__file__).with_name('benchmark-recognition.py'))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
manifest = json.loads((args.fixtures/'manifest.json').read_text(encoding='utf-8'))
replay = json.loads(args.replay.read_text(encoding='utf-8'))
rows = []
groups = {}
for row, trial in zip(replay['rows'], manifest['trials'], strict=True):
    assert row['id'] == trial['id']
    expected = row['expected']
    controls = [event for event in row['events'] if event['kind'] in ('ivy', 'clear-or-done', 'prompt', 'new session', 'reload mcp')]
    if trial['mode'] == 'composing' and not controls and not any(event['kind'] == 'conversation-submission' for event in row['events']):
        controls += [event for event in row['events'] if event['kind'] == 'composition-ended']
    names = [('clear-or-done' if expected in ('clear', 'done') else 'composition-ended' if expected == 'prompt cancel' else expected)] if expected else []
    correct = [event['kind'] for event in controls] == names
    unwanted = len(controls) - min(1, sum(event['kind'] in names for event in controls)) if expected else len(controls)
    proxy = None
    if manifest['fixtureKind'] == 'synthetic' and correct and expected and 'wake-request' not in row['id']:
        audio = harness.pcm(args.fixtures/(row['id']+'.wav'))
        voiced = np.flatnonzero(abs(audio.astype(np.int32)) >= 262)
        proxy = controls[0]['atAudioMs'] - (int(voiced[-1])+1)/16 if len(voiced) else None
        if proxy is not None and proxy < 0:
            proxy = None
    fallback = bool(correct and expected and any(item['command'] == expected for item in row['fallback']))
    # Draft previews can match a command before a later keyword action. A matching
    # transcript alone does not prove that STT, rather than KWS, caused the action.
    candidate = any(event['kind'] == 'keyword-candidate' and event['command'] == expected for event in row['events'])
    variant = trial['id'].split('-', 2)[-1] if 'voice' in trial else trial['id']
    item = {'id': row['id'], 'variant': variant, 'expected': expected, 'correct': correct,
            'unwantedActivations': unwanted, 'actionAudioProxyMs': proxy,
            'matchingSttAvailable': fallback, 'keywordCandidate': candidate, 'fallback': row['fallback'],
            'followingRequestSubmitted': any(event['kind'] == 'conversation-submission' for event in row['events']) if 'wake-request' in row['id'] else None}
    rows.append(item)
    for key in (expected or 'negative', 'variant:'+variant if expected else 'negative-all'):
        groups.setdefault(key, []).append(item)
summary = {}
for command, group in groups.items():
    measured = [row['actionAudioProxyMs'] for row in group if row['actionAudioProxyMs'] is not None]
    summary[command] = {'trials': len(group), 'correct': sum(row['correct'] for row in group),
                        'misses': sum(row['expected'] is not None and not row['correct'] for row in group),
                        'unwantedActivations': sum(row['unwantedActivations'] for row in group),
                        'successfulTrialsWithMatchingStt': sum(row['matchingSttAvailable'] for row in group),
                        'rescuedWithoutKeywordCandidate': sum(row['matchingSttAvailable'] and not row['keywordCandidate'] for row in group) if any(event['kind'] == 'keyword-candidate' for row in replay['rows'] for event in row['events']) else None,
                        'successfulActionProxyMedianMs': statistics.median(measured) if measured else None,
                        'proxyWithin250ms': sum(value <= 250 for value in measured),
                        'unknownOrMissedTiming': len(group)-len(measured),
                        'missInclusiveProxyP95Ms': sorted(measured)[int(len(group)*.95)] if len(measured) > int(len(group)*.95) else None}
evidence = {'scope': replay['scope'], 'fixtureKind': manifest['fixtureKind'],
            'timing': 'Action audio-time minus synthetic last-sample amplitude proxy; excludes IPC/scheduling/inference wall time. Fallback compute reported separately; no physical endpoint annotations for user recordings.',
            'summary': summary, 'rows': rows}
args.output.write_text(json.dumps(evidence, indent=2), encoding='utf-8')
print(json.dumps({key:value for key,value in summary.items() if not key.startswith('variant:')}))
