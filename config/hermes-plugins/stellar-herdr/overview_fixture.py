"""Generate browser fixtures through the real retained-registry reader, offline."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

from .overview import render, snapshot
from .test_outcomes import metadata, receipt


def generate(output):
    variants = [metadata(), metadata(status=None), metadata(status='blocked'),
                metadata(status_ms=0), metadata(state='finished', exit_code=0), None]
    rows = {}
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        for index, variant in enumerate(variants, 1):
            session, terminal, incarnation = f'fixture-352-{index}', f't{index}', f'{index:032x}'
            directory = root / 'attempts' / ('352-' + hashlib.sha256(session.encode()).hexdigest())
            directory.mkdir(parents=True)
            record = receipt(claim_session=session, terminal=terminal, incarnation=incarnation)
            (directory / 'terminal.json').write_text(json.dumps(record), encoding='utf-8')
            if variant is not None:
                variant = {**variant, 'address': terminal,
                           'labels': {**variant['labels'], 'stellar-launch': incarnation}}
            rows[terminal] = variant

        class FixtureCore:
            def call(self, action, terminal, flag, *, timeout):
                assert (action, flag, timeout) == ('get', '--json', 1)
                return rows[terminal]

        data = snapshot(root, FixtureCore(), clock=lambda: 1000)
    output.mkdir(parents=True, exist_ok=True)
    (output / 'fixture.html').write_text(render(data), encoding='utf-8')
    (output / 'fixture.json').write_text(json.dumps(data, indent=2), encoding='utf-8')
    return data


if __name__ == '__main__':
    generate(Path(sys.argv[1]))
