"""Lifecycle CLI for enrolled disposable copies, usable from the retained immutable bundle."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from .contract import ContractError
from .package import Package, enroll
from .package_io import within
from .provenance import verify_runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('prepare', 'install', 'verify', 'disable', 'remove', 'rollback', 'recover'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True, help='Existing read-only pinned bootstrap source; no version fallback')
    parser.add_argument('--restore-base', action='store_true')
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    try:
        verify_runtime(args.source)
        if args.operation == 'prepare':
            result = enroll(args.source, args.root).state
        else:
            package = Package(args.root)
            if args.operation != 'install' and not package.db_path.exists():
                raise ContractError('canonical_database_missing')
            home = within(package.root, 'fixture-home')
            home.mkdir(exist_ok=True)
            for key in ('HERMES_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'):
                os.environ[key] = str(home)
            sys.path.insert(0, str(args.source.resolve(strict=True)))
            def offline(event, values):
                if event in ('socket.connect', 'subprocess.Popen', 'os.system', 'os.exec'):
                    raise RuntimeError('No network/process/model in disposable lifecycle tool')
            sys.addaudithook(offline)
            from hermes_state import SessionDB
            db = SessionDB(package.db_path)
            try:
                if args.operation == 'remove':
                    result = package.remove(db, restore_base=args.restore_base)
                else:
                    result = getattr(package, {'rollback': 'rollback_install'}.get(args.operation, args.operation))(db)
            finally:
                db.close()
        print(json.dumps({'disposableOnly': True, 'installedCapability': False, 'result': result}))
    except ContractError as exc:
        print(json.dumps({'disposableOnly': True, 'error': exc.code, 'retryAuthorized': False}))
        sys.exit(1)
