"""Inert, root-owned filesystem primitives for issue #140.

No command in this module starts a worker or publishes a Git reference. The
caller supplies trusted paths and must keep executor containers stopped while
collecting their named volume.
"""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import uuid

MAX_FILES = 100_000
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
MAX_DEPTH = 64
REVISION = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")


def fail(message):
    raise ValueError(message)


def relative(name):
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(part in ('', '.', '..') for part in name.split('/'))
            or name.split('/')[0].lower() == '.git'):
        fail('Unsafe workspace path')
    return name


def command(*args, cwd=None, limit=MAX_FILE + 1):
    result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=30, check=True)
    if len(result.stdout) > limit:
        fail('Git output exceeds limit')
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def object_digest(data, oid):
    kind = hashlib.sha1 if len(oid) == 40 else hashlib.sha256
    value = kind(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    if value != oid:
        fail('Git object bytes differ from pinned object ID')


def ensure_root():
    if os.geteuid() != 0:
        fail('Trusted workspace operations require WSL root')


def trusted_parent(destination):
    destination = os.path.abspath(destination)
    parent = os.path.dirname(destination)
    parent_stat = os.lstat(parent)
    if (not stat.S_ISDIR(parent_stat.st_mode) or parent_stat.st_uid != 0
            or parent_stat.st_mode & 0o022 or os.path.lexists(destination)):
        fail('Destination parent is not trusted or destination exists')
    return destination, parent


def write_tree(destination, entries, source):
    ensure_root()
    destination, parent = trusted_parent(destination)
    staging = os.path.join(parent, '.immutable-' + uuid.uuid4().hex)
    os.mkdir(staging, 0o700)
    records = []
    total = 0
    try:
        seen = set()
        for name, data, executable in sorted(entries, key=lambda item: item[0]):
            relative(name)
            key = name.casefold()
            if key in seen or len(records) >= MAX_FILES or len(name.split('/')) > MAX_DEPTH:
                fail('Duplicate or oversized workspace tree')
            seen.add(key)
            total += len(data)
            if len(data) > MAX_FILE or total > MAX_TOTAL:
                fail('Workspace content exceeds limit')
            target = os.path.join(staging, *name.split('/'))
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
            finally:
                os.close(fd)
            os.chmod(target, 0o555 if executable else 0o444)
            records.append({'path': name, 'bytes': len(data), 'sha256': digest(data),
                            'executable': bool(executable)})
        manifest = {'schema': 'stellar.immutable-workspace/v1', 'source': source,
                    'files': records}
        encoded = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
        manifest['digest'] = digest(encoded)
        manifest_path = staging + '.json'
        fd = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600)
        try:
            os.write(fd, json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        # Directories are read-only to the executor, including the root.
        for root, dirs, _ in os.walk(staging, topdown=False, followlinks=False):
            for folder in dirs:
                os.chmod(os.path.join(root, folder), 0o555)
            os.chmod(root, 0o555)
        os.chmod(manifest_path, 0o444)
        os.rename(staging, destination)
        os.rename(manifest_path, destination + '.json')
        parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        return manifest
    except Exception:
        import shutil
        shutil.rmtree(staging, ignore_errors=True)
        if os.path.exists(staging + '.json'):
            os.unlink(staging + '.json')
        raise


def git_source(repository, revision):
    ensure_root()
    if not REVISION.fullmatch(revision):
        fail('Invalid pinned Git revision')
    if command('git', 'rev-parse', 'HEAD', cwd=repository, limit=128).strip().decode() != revision:
        fail('Git HEAD differs from pinned revision')
    index = command('git', 'ls-files', '--cached', '--stage', '-v', '-z',
                    cwd=repository, limit=8 * 1024 * 1024)
    if any(not re.fullmatch(rb'H (?:100644|100755) [0-9a-f]{40}(?:[0-9a-f]{24})? 0\t[^\0]+', record)
           for record in index.split(b'\0') if record):
        fail('Unsafe Git index entry')
    if command('git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
               'status', '--porcelain=v1', '--untracked-files=all', cwd=repository,
               limit=8 * 1024 * 1024):
        fail('Initial Git source must be clean')
    listing = command('git', 'ls-tree', '-r', '-z', revision, cwd=repository,
                      limit=8 * 1024 * 1024)
    entries = []
    for record in listing.split(b'\0'):
        if not record:
            continue
        metadata, separator, raw_name = record.partition(b'\t')
        pieces = metadata.split(b' ')
        if separator != b'\t' or len(pieces) != 3 or pieces[0] not in (b'100644', b'100755') or pieces[1] != b'blob':
            fail('Git tree contains unsupported entry')
        name = relative(raw_name.decode('utf-8', 'strict'))
        oid = pieces[2].decode('ascii')
        if not REVISION.fullmatch(oid):
            fail('Malformed Git object ID')
        data = command('git', 'cat-file', 'blob', oid, cwd=repository)
        object_digest(data, oid)
        entries.append((name, data, pieces[0] == b'100755'))
    if command('git', 'rev-parse', 'HEAD', cwd=repository, limit=128).strip().decode() != revision:
        fail('Git revision changed during capture')
    return entries


def read_tree(source):
    """Read a stopped private volume through no-follow descriptors."""
    root = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    root_identity = os.fstat(root)
    output = []
    total = 0
    def walk(fd, prefix, depth):
        nonlocal total
        if depth > MAX_DEPTH:
            fail('Workspace depth exceeds limit')
        for name in sorted(os.listdir(fd)):
            relative(prefix + name)
            before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(before.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=fd)
                try:
                    if (os.fstat(child).st_dev, os.fstat(child).st_ino) != (before.st_dev, before.st_ino):
                        fail('Directory changed during collection')
                    walk(child, prefix + name + '/', depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(before.st_mode) and before.st_nlink == 1:
                if before.st_size > MAX_FILE or len(output) >= MAX_FILES:
                    fail('Workspace file exceeds limit')
                file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                  dir_fd=fd)
                try:
                    opened = os.fstat(file_fd)
                    if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_size) != (before.st_dev, before.st_ino, before.st_mode, before.st_size):
                        fail('File changed during collection')
                    chunks = []
                    size = 0
                    while True:
                        chunk = os.read(file_fd, 65536)
                        if not chunk:
                            break
                        size += len(chunk)
                        total += len(chunk)
                        if size > MAX_FILE or total > MAX_TOTAL:
                            fail('Workspace content exceeds limit')
                        chunks.append(chunk)
                    after = os.fstat(file_fd)
                    current = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if ((before.st_dev, before.st_ino, before.st_mode, before.st_size,
                         before.st_mtime_ns, before.st_ctime_ns) !=
                        (after.st_dev, after.st_ino, after.st_mode, after.st_size,
                         after.st_mtime_ns, after.st_ctime_ns) or
                        (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino)):
                        fail('File changed during collection')
                    output.append((prefix + name, b''.join(chunks), bool(before.st_mode & 0o111)))
                finally:
                    os.close(file_fd)
            else:
                fail('Workspace contains link or special file')
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if (before.st_dev, before.st_ino, before.st_mode) != (current.st_dev, current.st_ino, current.st_mode):
                fail('Directory entry changed during collection')
    try:
        walk(root, '', 0)
        final_root = os.stat(source, follow_symlinks=False)
        if (root_identity.st_dev, root_identity.st_ino) != (final_root.st_dev, final_root.st_ino):
            fail('Workspace root changed during collection')
        return output
    finally:
        os.close(root)


def assert_root_seal(tree, manifest_path):
    for root, dirs, files in os.walk(tree, followlinks=False):
        for item in [root, *(os.path.join(root, name) for name in dirs + files)]:
            info = os.lstat(item)
            if info.st_uid != 0 or info.st_mode & 0o222:
                fail('Sealed workspace is not root-owned and read-only')
    info = os.lstat(manifest_path)
    if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o222:
        fail('Sealed manifest is not root-owned and read-only')


def collect(volume_path, source_manifest_path, destination, allowed, protected):
    ensure_root()
    with open(source_manifest_path, encoding='utf-8') as source_file:
        baseline = json.load(source_file)
    if baseline.get('schema') != 'stellar.immutable-workspace/v1':
        fail('Invalid source manifest')
    check = dict(baseline)
    baseline_digest = check.pop('digest', None)
    if baseline_digest != digest(json.dumps(check, sort_keys=True, separators=(',', ':')).encode()):
        fail('Altered source manifest')
    if not source_manifest_path.endswith('.json') or verify(source_manifest_path[:-5], source_manifest_path) != baseline_digest:
        fail('Source tree is not sealed to its manifest')
    permitted = [relative(item) for item in allowed]
    protected = [relative(item) for item in protected]
    if not permitted or not protected:
        fail('Trusted change and protected paths are required')
    if any(item == guard or item.startswith(guard + '/') or guard.startswith(item + '/')
           for item in permitted for guard in protected):
        fail('Authorized changes overlap protected paths')
    files = read_tree(volume_path)
    old = {item['path']: item for item in baseline['files']}
    new = {name: (digest(data), len(data), executable) for name, data, executable in files}
    changed = sorted(name for name in old.keys() | new.keys()
                     if (old.get(name, {}).get('sha256'), old.get(name, {}).get('bytes'),
                         old.get(name, {}).get('executable')) != new.get(name))
    if not changed or any(not any(name == item or name.startswith(item + '/') for item in permitted) or
                          any(name == guard or name.startswith(guard + '/') for guard in protected)
                          for name in changed):
        fail('No authorized changes or output escaped authorized paths')
    # A second full read must match before sealing, including every unchanged path.
    repeated = read_tree(volume_path)
    if [(n, digest(d), x) for n, d, x in files] != [(n, digest(d), x) for n, d, x in repeated]:
        fail('Volume changed during collection')
    return write_tree(destination, files, {'kind': 'candidate',
                                            'baselineDigest': baseline['digest'],
                                            'changedPaths': changed})


def verify(tree, manifest_path):
    assert_root_seal(tree, manifest_path)
    with open(manifest_path, encoding='utf-8') as source_file:
        manifest = json.load(source_file)
    expected = dict(manifest)
    recorded = expected.pop('digest', None)
    if (manifest.get('schema') != 'stellar.immutable-workspace/v1' or
        recorded != digest(json.dumps(expected, sort_keys=True, separators=(',', ':')).encode())):
        fail('Invalid or altered manifest')
    actual = sorted(({'path': name, 'bytes': len(data), 'sha256': digest(data),
                      'executable': executable} for name, data, executable in read_tree(tree)),
                    key=lambda item: item['path'])
    if actual != manifest['files']:
        fail('Sealed tree differs from manifest')
    return recorded


def main(argv):
    if len(argv) < 2:
        fail('Expected capture, collect, or verify')
    action = argv[1]
    if action == 'capture' and len(argv) == 5:
        result = write_tree(argv[4], git_source(argv[2], argv[3]),
                            {'kind': 'git', 'revision': argv[3]})
    elif action == 'collect' and len(argv) == 7:
        result = collect(argv[2], argv[3], argv[4], json.loads(argv[5]),
                         json.loads(argv[6]))
    elif action == 'verify' and len(argv) == 4:
        result = {'digest': verify(argv[2], argv[3])}
    else:
        fail('Invalid operation arguments')
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main(sys.argv)
    except Exception as error:
        print('Immutable workspace operation rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
