"""Export a reviewable diff/hash manifest; never apply to the runtime or change settings."""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[2]

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    destination = args.output.resolve()
    if not destination.is_relative_to(REPO / 'artifacts/issue-339'):
        parser.error('output must be inside this issue worktree artifacts/issue-339')
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(REPO / 'config/hermes-compat/stellar-background-v1'))
    from stellar_background.overlay import transformed
    modified = transformed(args.runtime)
    changes, manifest = [], {'schemaVersion': 1, 'installedCapability': False, 'files': {}}
    for name, value in modified.items():
        before = (args.runtime / name).read_bytes()
        manifest['files'][name] = {'before': hashlib.sha256(before).hexdigest(),
                                 'after': hashlib.sha256(value.encode('utf-8')).hexdigest()}
        changes.extend(difflib.unified_diff(before.decode('utf-8').splitlines(keepends=True),
                       value.splitlines(keepends=True), fromfile='a/' + name, tofile='b/' + name))
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'host-seam.patch').write_bytes(''.join(changes).encode('utf-8'))
    (destination / 'host-seam-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(modified), 'installedCapability': False, 'output': str(destination)}))
