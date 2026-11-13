"""Filesystem primitives restricted to enrolled disposable source copies, not a live installer."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
import secrets
from pathlib import Path
import tempfile

from .contract import ContractError


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_root(value):
    raw = Path(value).absolute()
    root, temporary = raw.resolve(strict=True), Path(tempfile.gettempdir()).resolve(strict=True)
    if root == temporary or not root.is_relative_to(temporary) or not root.is_dir():
        raise ContractError('disposable_root_required')
    if raw != root or any(p.is_symlink() or p.is_junction() for p in (root, *root.parents) if p.is_relative_to(temporary)):
        raise ContractError('indirect_path_refused')
    return root


def within(root, name):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts:
        raise ContractError('indirect_path_refused')
    target = root / relative
    if not target.resolve().is_relative_to(root):
        raise ContractError('indirect_path_refused')
    for path in (target, *target.parents):
        if path == root:
            break
        if path.is_symlink() or path.is_junction() or (path.is_file() and path.stat().st_nlink != 1):
            raise ContractError('indirect_path_refused')
    return target


def atomic(root, name, data):
    target = within(root, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = within(root, 'package-staging')
    staging.mkdir(exist_ok=True)
    # Orphans are bounded, non-executable evidence, never trusted or silently deleted.
    existing = list(staging.iterdir())
    if len(existing) >= 64 or sum(p.stat().st_size for p in existing if p.is_file()) > 16 * 1024 * 1024:
        raise ContractError('staging_capacity')
    temporary = within(root, 'package-staging/' + secrets.token_hex(24) + '.pending')
    with temporary.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    # Windows offers no portable directory fsync. Recovery verifies every byte against both
    # allowed images plus canonical DB state; it never assumes a rename proves activation.
    if os.name != 'nt':
        descriptor = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def write_json(root, name, value):
    atomic(root, name, (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8'))


def read_json(root, name):
    return json.loads(within(root, name).read_text(encoding='utf-8'))


@contextmanager
def exclusive(root):
    path = within(root, 'runtime-use.lock')
    with path.open('a+b') as stream:
        try:
            stream.seek(0)
            if not stream.read(1):
                stream.write(b'0'); stream.flush()
            stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ContractError('runtime_in_use') from None
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def remove_owned(root, prefix, expected):
    folder = within(root, prefix)
    actual = {str(p.relative_to(folder)).replace('\\', '/') for p in folder.rglob('*') if p.is_file()} if folder.exists() else set()
    if not actual <= set(expected):
        raise ContractError('unknown_package_files')
    for name in actual:
        path = within(root, prefix + '/' + name)
        if digest(path.read_bytes()) != expected[name]:
            raise ContractError('package_mismatch')
    for name in actual:
        within(root, prefix + '/' + name).unlink()
    if folder.exists():
        for path in sorted(folder.rglob('*'), key=lambda p: len(p.parts), reverse=True):
            if path.is_dir():
                within(root, str(path.relative_to(root))).rmdir()
        folder.rmdir()
