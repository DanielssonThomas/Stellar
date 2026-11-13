"""Reproduce the pinned Python Unicode-16 printable range data; no Hermes imports."""
from pathlib import Path
import argparse
import hashlib
import json
import struct
import unicodedata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if unicodedata.unidata_version != '16.0.0':
        raise SystemExit('Refuse changed Unicode baseline; reviewed migration required')
    ranges, start = [], None
    for point in range(0x110001):
        printable = point < 0x110000 and chr(point).isprintable()
        if printable and start is None:
            start = point
        elif not printable and start is not None:
            ranges.append((start, point - 1))
            start = None
    data = b''.join(struct.pack('<II', first, last) for first, last in ranges)
    root = Path(__file__).resolve().parents[1] / 'native' / 'consent-broker' / 'data'
    metadata = {
        'unicodeVersion': unicodedata.unidata_version,
        'source': 'Pinned CPython 3.14 str.isprintable over all Unicode code points',
        'format': 'sorted inclusive u32 little-endian start/end pairs',
        'ranges': len(ranges), 'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
        'identifierScalarSha256': hashlib.sha256(bytes(
            int(chr(point).isprintable() and not chr(point).isspace())
            for point in range(0x110000))).hexdigest(),
        'authority': 'Character classification data only; no consent or launch authority',
    }
    outputs = {'printable-16.bin': data,
               'printable-16.json': (json.dumps(metadata, indent=2) + '\n').encode()}
    for name, content in outputs.items():
        path = root / name
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                raise SystemExit(f'Unicode data mismatch: {name}')
        else:
            root.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    print(json.dumps({'checked': args.check, **metadata}))


if __name__ == '__main__':
    main()
