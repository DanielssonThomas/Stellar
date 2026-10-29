"""Inert, root-owned filesystem primitives for issue #140.

No command in this module starts a worker or publishes a Git reference. The
caller supplies trusted paths and must keep executor containers stopped while
collecting their named volume.
"""

import hashlib
import json
import os
import re
import resource
import selectors
import signal
import stat
import subprocess
import sys
import time

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


def command(*args, cwd=None, limit=MAX_FILE + 1, run_uid=None, run_gid=None):
    """Bound stdout while the unprivileged Git process is still running."""
    if not args or args[0] != 'git' or not cwd or limit < 1 or limit > MAX_TOTAL:
        fail('Invalid bounded Git invocation')
    if os.geteuid() == 0 and (run_uid is None or run_gid is None or run_uid == 0):
        fail('Root must not execute Git against source data')

    def confine_child():
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        if os.geteuid() == 0:
            os.setgroups([])
            os.setgid(run_gid)
            os.setuid(run_uid)

    environment = {
        'PATH': '/usr/bin:/bin',
        'HOME': '/nonexistent',
        'LANG': 'C',
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_OPTIONAL_LOCKS': '0',
        'GIT_NO_REPLACE_OBJECTS': '1',
        'GIT_TERMINAL_PROMPT': '0',
        'GIT_PAGER': 'cat',
    }
    process = subprocess.Popen(
        ['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
         '-c', 'core.ignorestat=false', '-c', 'core.hooksPath=/dev/null', *args[1:]],
        cwd=cwd, env=environment, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, start_new_session=True,
        preexec_fn=confine_child,
    )
    output = bytearray()
    deadline = time.monotonic() + 30
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                fail('Git subprocess timed out')
            if not selector.select(min(0.2, deadline - time.monotonic())):
                continue
            chunk = os.read(process.stdout.fileno(), min(65536, limit - len(output) + 1))
            if not chunk:
                selector.unregister(process.stdout)
                break
            output.extend(chunk)
            if len(output) > limit:
                fail('Git output exceeds limit')
        if process.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
            fail('Git subprocess failed')
        return bytes(output)
    except Exception:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise
    finally:
        selector.close()
        process.stdout.close()


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
            or parent_stat.st_mode & 0o022 or os.path.realpath(parent) != parent
            or os.path.lexists(destination)):
        fail('Destination parent is not trusted or destination exists')
    return destination, parent


def write_tree(destination, entries, source):
    ensure_root()
    destination, parent = trusted_parent(destination)
    staging = destination + '.pending'
    manifest_path = destination + '.json.pending'
    if (os.path.lexists(destination) or os.path.lexists(staging) or
            os.path.lexists(manifest_path) or os.path.lexists(destination + '.json')):
        fail('Interrupted snapshot publication requires quarantine')
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
        if os.path.exists(manifest_path):
            os.unlink(manifest_path)
        raise


def inspect_publication(destination):
    destination = os.path.abspath(destination)
    states = {
        'tree': os.path.lexists(destination),
        'manifest': os.path.lexists(destination + '.json'),
        'pendingTree': os.path.lexists(destination + '.pending'),
        'pendingManifest': os.path.lexists(destination + '.json.pending'),
    }
    states['safeToConsume'] = (states['tree'] and states['manifest'] and
                               not states['pendingTree'] and not states['pendingManifest'])
    return states


def read_one(root_path, name, expected_uid):
    relative(name)
    root = os.open(root_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    opened = [root]
    try:
        parent = root
        for part in name.split('/')[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=parent)
            if os.fstat(child).st_uid != expected_uid:
                os.close(child)
                fail('Changed source directory has another owner')
            opened.append(child)
            parent = child
        leaf = name.split('/')[-1]
        try:
            fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=parent)
        except FileNotFoundError:
            return None
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != expected_uid
                    or before.st_nlink != 1 or before.st_size > MAX_FILE):
                fail('Changed source is not an isolated bounded regular file')
            chunks = []
            total = 0
            while True:
                chunk = os.read(fd, min(65536, MAX_FILE - total + 1))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_FILE:
                    fail('Changed source exceeds file limit')
            after = os.fstat(fd)
            current = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            if ((before.st_dev, before.st_ino, before.st_mode, before.st_size,
                 before.st_mtime_ns, before.st_ctime_ns) !=
                (after.st_dev, after.st_ino, after.st_mode, after.st_size,
                 after.st_mtime_ns, after.st_ctime_ns) or
                (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino)):
                fail('Changed source moved during capture')
            return b''.join(chunks), bool(before.st_mode & 0o111)
        finally:
            os.close(fd)
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def status_paths(raw):
    if raw and not raw.endswith(b'\0'):
        fail('Incomplete Git status output')
    records = raw[:-1].split(b'\0') if raw else []
    paths = set()
    offset = 0
    while offset < len(records):
        record = records[offset]
        if len(record) < 4 or record[2:3] != b' ':
            fail('Malformed Git status output')
        paths.add(relative(record[3:].decode('utf-8', 'strict')))
        if b'R' in record[:2] or b'C' in record[:2]:
            offset += 1
            if offset >= len(records):
                fail('Incomplete Git rename output')
            paths.add(relative(records[offset].decode('utf-8', 'strict')))
        offset += 1
    return paths


def expected_changes(value):
    if not isinstance(value, list) or len(value) > 100:
        fail('Expected source changes must be bounded')
    checked = {}
    for item in value:
        if not isinstance(item, dict) or set(item) != {'path', 'sha256', 'executable', 'ignored'}:
            fail('Invalid expected source change')
        name = relative(item['path'])
        sha = item['sha256']
        if (name in checked or (sha is not None and not re.fullmatch(r'[a-f0-9]{64}', sha))
                or not isinstance(item['executable'], bool)
                or not isinstance(item['ignored'], bool)
                or item['ignored'] and sha is None):
            fail('Invalid or duplicate expected source change')
        checked[name] = item
    return checked


def git_source(repository, revision, changes=None):
    ensure_root()
    if not REVISION.fullmatch(revision):
        fail('Invalid pinned Git revision')
    repository = os.path.abspath(repository)
    source_stat = os.lstat(repository)
    if (not stat.S_ISDIR(source_stat.st_mode) or os.path.realpath(repository) != repository
            or source_stat.st_uid == 0):
        fail('Git source must be an unprivileged plain checkout')
    run_uid, run_gid = source_stat.st_uid, source_stat.st_gid
    def git(*args, limit=MAX_FILE + 1):
        return command('git', *args, cwd=repository, limit=limit,
                       run_uid=run_uid, run_gid=run_gid)
    if git('rev-parse', 'HEAD', limit=128).strip().decode() != revision:
        fail('Git HEAD differs from pinned revision')
    index = git('ls-files', '--cached', '--stage', '-v', '-z', limit=8 * 1024 * 1024)
    if any(not re.fullmatch(rb'H (?:100644|100755) [0-9a-f]{40}(?:[0-9a-f]{24})? 0\t[^\0]+', record)
           for record in index.split(b'\0') if record):
        fail('Unsafe Git index entry')
    changes = expected_changes([] if changes is None else changes)
    status = status_paths(git('status', '--porcelain=v1', '-z',
                              '--untracked-files=all', limit=8 * 1024 * 1024))
    if status != {name for name, item in changes.items() if not item['ignored']}:
        fail('Git source differs from expected changed paths')
    listing = git('ls-tree', '-r', '-z', revision, limit=8 * 1024 * 1024)
    entries = {}
    source_bytes = 0
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
        data = git('cat-file', 'blob', oid)
        object_digest(data, oid)
        if name in entries:
            fail('Duplicate Git tree path')
        source_bytes += len(data)
        if len(entries) >= MAX_FILES or source_bytes > MAX_TOTAL:
            fail('Git source exceeds workspace limits')
        entries[name] = (name, data, pieces[0] == b'100755')
    for name, item in changes.items():
        if item['ignored'] and git('check-ignore', '--no-index', '--', name, limit=128) != (name + '\n').encode():
            fail('Expected ignored input is not ignored')
        captured = read_one(repository, name, run_uid)
        if item['sha256'] is None:
            if captured is not None:
                fail('Expected source deletion is present')
            entries.pop(name, None)
        else:
            if captured is None or digest(captured[0]) != item['sha256'] or captured[1] != item['executable']:
                fail('Changed source differs from trusted digest')
            entries[name] = (name, captured[0], captured[1])
    if (len(entries) > MAX_FILES or
            sum(len(item[1]) for item in entries.values()) > MAX_TOTAL):
        fail('Changed source exceeds workspace limits')
    if (git('rev-parse', 'HEAD', limit=128).strip().decode() != revision or
            git('ls-files', '--cached', '--stage', '-v', '-z', limit=8 * 1024 * 1024) != index or
            status_paths(git('status', '--porcelain=v1', '-z', '--untracked-files=all',
                             limit=8 * 1024 * 1024)) != status):
        fail('Git revision changed during capture')
    for name, item in changes.items():
        captured = read_one(repository, name, run_uid)
        if item['sha256'] is None:
            if captured is not None:
                fail('Deleted source reappeared during capture')
        elif captured is None or digest(captured[0]) != item['sha256'] or captured[1] != item['executable']:
            fail('Changed source moved during capture')
    return list(entries.values())


def read_tree(source):
    """Read a stopped private volume through no-follow descriptors."""
    root = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    root_identity = os.fstat(root)
    output = []
    total = 0
    entry_count = 0
    deadline = time.monotonic() + 120
    def walk(fd, prefix, depth):
        nonlocal total, entry_count
        if depth > MAX_DEPTH:
            fail('Workspace depth exceeds limit')
        for entry in os.scandir(fd):
            entry_count += 1
            if entry_count > MAX_FILES or time.monotonic() > deadline:
                fail('Workspace entries or collection time exceed limit')
            name = entry.name
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
        return sorted(output, key=lambda item: item[0])
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
    if action == 'capture' and len(argv) in (5, 6):
        expected = json.loads(argv[5]) if len(argv) == 6 else []
        result = write_tree(argv[4], git_source(argv[2], argv[3], expected),
                            {'kind': 'git', 'revision': argv[3],
                             'changedInput': expected_changes(expected)})
    elif action == 'collect' and len(argv) == 7:
        result = collect(argv[2], argv[3], argv[4], json.loads(argv[5]),
                         json.loads(argv[6]))
    elif action == 'verify' and len(argv) == 4:
        result = {'digest': verify(argv[2], argv[3])}
    elif action == 'inspect-publication' and len(argv) == 3:
        result = inspect_publication(argv[2])
    else:
        fail('Invalid operation arguments')
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main(sys.argv)
    except Exception as error:
        print('Immutable workspace operation rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
