"""Hash bounded changed files without following workspace symlinks.

Run only from the trusted host, via stdin to the isolated account's Python.
Only digests and file metadata leave this process, never file contents.
"""

import hashlib
import json
import os
import stat
import sys

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024


def identity(info):
    # Nanosecond times and inode IDs can exceed JavaScript's safe integer range.
    return [str(value) for value in (info.st_dev, info.st_ino, info.st_mode,
                                    info.st_size, info.st_mtime_ns, info.st_ctime_ns)]


def inspect_files(workspace, paths):
    if (not os.path.isabs(workspace) or os.path.realpath(workspace) != workspace
            or len(paths) > 100 or len(set(paths)) != len(paths)):
        raise ValueError("Invalid workspace inspection scope")
    root = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    records = []
    total = 0
    try:
        for name in sorted(paths):
            parts = name.split('/')
            if (not name or any(part in ('', '.', '..') for part in parts)
                    or '\x00' in name or parts[0] == '.git'):
                raise ValueError("Invalid workspace path")
            parent = root
            opened = []
            links = []
            try:
                missing = False
                for part in parts[:-1]:
                    try:
                        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY |
                                        os.O_NOFOLLOW, dir_fd=parent)
                    except FileNotFoundError:
                        missing = True
                        break
                    opened.append(child)
                    links.append((parent, part, os.fstat(child)))
                    parent = child
                if missing:
                    records.append([name, 'missing'])
                    continue
                try:
                    descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW |
                                         os.O_NONBLOCK, dir_fd=parent)
                except FileNotFoundError:
                    records.append([name, 'missing'])
                    continue
                try:
                    before = os.fstat(descriptor)
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                        raise ValueError("Workspace file is not an isolated regular file")
                    if before.st_size > MAX_FILE_BYTES:
                        raise ValueError("Workspace file exceeds inspection limit")
                    digest = hashlib.sha256()
                    size = 0
                    while True:
                        chunk = os.read(descriptor, 64 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        total += len(chunk)
                        if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
                            raise ValueError("Workspace content exceeds inspection limit")
                        digest.update(chunk)
                    after = os.fstat(descriptor)
                    current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                    if (identity(before) != identity(after)
                            or identity(before) != identity(current)
                            or size != before.st_size):
                        raise ValueError("Workspace file changed during inspection")
                    records.append([name, 'regular', identity(before), digest.hexdigest()])
                finally:
                    os.close(descriptor)
            finally:
                try:
                    for directory, part, before in links:
                        current = os.stat(part, dir_fd=directory, follow_symlinks=False)
                        if (current.st_dev, current.st_ino, current.st_mode) != (
                                before.st_dev, before.st_ino, before.st_mode):
                            raise ValueError("Workspace directory changed during inspection")
                finally:
                    for descriptor in reversed(opened):
                        os.close(descriptor)
        current_root = os.stat(workspace, follow_symlinks=False)
        opened_root = os.fstat(root)
        if (current_root.st_dev, current_root.st_ino) != (opened_root.st_dev, opened_root.st_ino):
            raise ValueError("Workspace identity changed during inspection")
        return records
    finally:
        os.close(root)


if __name__ == '__main__':
    try:
        print(json.dumps(inspect_files(sys.argv[1], json.loads(sys.argv[2])),
                         ensure_ascii=True, separators=(',', ':')))
    except Exception:
        # Neither paths nor file/process output belong in public diagnostics.
        sys.exit('Trusted workspace file inspection failed.')
