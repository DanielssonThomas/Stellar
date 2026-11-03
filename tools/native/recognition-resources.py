"""Bounded process-tree telemetry for the explicitly launched native smoke PID."""
import argparse
import json
import os
from pathlib import Path
import time
import psutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
parent = psutil.Process(args.pid)
created = parent.create_time()
start = time.monotonic()
rows = []
previous = {}
profile = os.path.normcase(str(Path(__file__).resolve().parents[2] / 'artifacts/native/recognition-webview-profile'))
profiles = {profile, os.path.join(profile, 'ebwebview')}
for _ in range(90):
    try:
        if not parent.is_running() or parent.create_time() != created:
            break
        members = {member.pid: member for member in [parent, *parent.children(recursive=True)]}
    except psutil.NoSuchProcess:
        break
    # WebView2 can be broker-launched rather than a descendant of the app.
    # Correlate only the isolated test profile, never other Stellar/Codex windows.
    webview_members = 0
    for candidate in psutil.process_iter(['name', 'cmdline']):
        try:
            if (candidate.info['name'] or '').lower() != 'msedgewebview2.exe':
                continue
            directories = [arg.split('=', 1)[1].strip('"') for arg in candidate.info['cmdline'] or []
                           if arg.startswith('--user-data-dir=')]
            if any(os.path.normcase(os.path.abspath(path)) in profiles for path in directories):
                members[candidate.pid] = candidate
                webview_members += 1
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    rss = 0
    delta = 0
    current = {}
    webview_members = 0
    for member in members.values():
        try:
            key = (member.pid, member.create_time())
            cpu = sum(member.cpu_times()[:2])
            rss += member.memory_info().rss
            if key in previous:
                delta += cpu - previous[key]
            current[key] = cpu
            if member.name().lower() == 'msedgewebview2.exe':
                webview_members += 1
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    now = time.monotonic()
    wall = time.time()*1000
    rows.append({'elapsedSeconds': now-start, 'atUnixMs': wall, 'intervalStartUnixMs': last_wall if previous else None,
                 'rssMiB': rss/2**20, 'members': len(current), 'webviewMembers': webview_members,
                 'cpuPercentOneCore': delta/(now-last)*100 if previous else None})
    previous = current
    last = now
    last_wall = wall
    time.sleep(1)
args.output.write_text(json.dumps({'scope': 'Root descendants plus WebView processes matching the isolated test data directory; summed RSS may double-count shared pages. No total-app claim if webviewMembers is zero.',
                                   'vram': 'not measured', 'rows': rows}, indent=2), encoding='utf-8')
