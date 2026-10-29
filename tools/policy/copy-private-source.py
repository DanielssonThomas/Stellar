"""Copy a bounded source tree into one private, attempt-named directory.

The trusted host supplies validated paths and invokes this as Peon through
stdin. A .incomplete marker remains until the host rechecks source identity.
"""

import hashlib
import json
import os
import re
import stat
import sys

MAX_FILES = 1000
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_PATH_BYTES = 512
OPEN_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def valid_path(name):
    if not isinstance(name, str) or not name or len(name.encode('utf-8')) > MAX_PATH_BYTES:
        return False
    parts = name.split('/')
    return (name not in ('.incomplete', 'manifest.json')
            and not name.startswith('/') and '\\' not in name and ':' not in name
            and all(part not in ('', '.', '..', '.git', '.gitmodules') for part in parts)
            and all(ord(character) >= 32 and ord(character) != 127 for character in name))


def open_parent(root, parts, create=False):
    parent = os.dup(root)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=parent)
                except FileExistsError:
                    pass
            child = os.open(part, OPEN_DIRECTORY, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent
    except BaseException:
        os.close(parent)
        raise


def read_file(root, name, expected=None):
    parts = name.split('/')
    parent = open_parent(root, parts)
    try:
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=parent)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise ValueError('Unsafe source type')
            if before.st_size > MAX_FILE_BYTES:
                raise ValueError('Source file exceeds limit')
            digest = hashlib.sha256()
            size = 0
            chunks = []
            while True:
                chunk = os.read(descriptor, 64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise ValueError('Source file exceeds limit')
                digest.update(chunk)
                chunks.append(chunk)
            after = os.fstat(descriptor)
            current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if identity(before) != identity(after) or identity(before) != identity(current) or size != before.st_size:
                raise ValueError('Source changed during copy')
            result = (size, digest.hexdigest(), identity(before))
            if expected is not None and result != expected:
                raise ValueError('Source changed during copy')
            return result, chunks
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def write_file(root, name, chunks, mode=0o600):
    parts = name.split('/')
    parent = open_parent(root, parts, create=True)
    try:
        descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                             os.O_NOFOLLOW, mode, dir_fd=parent)
        try:
            for chunk in chunks:
                remaining = memoryview(chunk)
                while remaining:
                    remaining = remaining[os.write(descriptor, remaining):]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def open_root(name, private=False):
    if (not isinstance(name, str) or not os.path.isabs(name)
            or os.path.realpath(name) != name):
        raise ValueError('Unsafe root')
    descriptor = os.open(name, OPEN_DIRECTORY)
    info = os.fstat(descriptor)
    if (not stat.S_ISDIR(info.st_mode)
            or (private and (info.st_uid != os.geteuid() or info.st_mode & 0o077))):
        os.close(descriptor)
        raise ValueError('Unsafe root')
    return descriptor


def validate_identity(attempt, revision, fingerprint):
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', attempt)
            or not re.fullmatch(r'[a-f0-9]{40,64}', revision)
            or not re.fullmatch(r'[a-f0-9]{64}', fingerprint)):
        raise ValueError('Invalid attempt identity')


def manifest_digest(attempt, revision, fingerprint, files):
    material = json.dumps(['private-source-v1', attempt, revision, fingerprint, files],
                          ensure_ascii=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(material).hexdigest()


def scan_metadata(root, ignored):
    count = 0

    def visit(directory, prefix, depth):
        nonlocal count
        if depth > 64:
            raise ValueError('Source tree exceeds depth limit')
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                if count > 100_000:
                    raise ValueError('Source tree exceeds entry limit')
                name = prefix + entry.name
                if name == '.git':
                    metadata = entry.stat(follow_symlinks=False)
                    if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
                        raise ValueError('Unsafe Git metadata')
                    continue
                if entry.name in ('.git', '.gitmodules'):
                    raise ValueError('Unexpected Git metadata')
                before = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(before.st_mode):
                    if name + '/' in ignored:
                        continue
                    child = os.open(entry.name, OPEN_DIRECTORY, dir_fd=directory)
                    try:
                        if identity(before) != identity(os.fstat(child)):
                            raise ValueError('Source directory changed')
                        visit(child, name + '/', depth + 1)
                        after = os.stat(entry.name, dir_fd=directory,
                                        follow_symlinks=False)
                        if identity(before) != identity(after):
                            raise ValueError('Source directory changed')
                    finally:
                        os.close(child)
                elif not stat.S_ISREG(before.st_mode):
                    raise ValueError('Unsafe source entry')

    visit(root, '', 0)


def list_private_files(root):
    names = []
    entries_seen = 0
    def visit(directory, prefix, depth):
        nonlocal entries_seen
        if depth > 64 or len(names) > MAX_FILES:
            raise ValueError('Private tree exceeds limit')
        with os.scandir(directory) as entries:
            for entry in entries:
                entries_seen += 1
                if entries_seen > 100_000:
                    raise ValueError('Private tree exceeds entry limit')
                name = prefix + entry.name
                if not valid_path(name):
                    raise ValueError('Unsafe private path')
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, OPEN_DIRECTORY, dir_fd=directory)
                    try:
                        visit(child, name + '/', depth + 1)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    names.append(name)
                else:
                    raise ValueError('Unsafe private file type')
    visit(root, '', 0)
    if len(names) > MAX_FILES:
        raise ValueError('Private tree exceeds limit')
    return sorted(names)


def file_snapshot(root, protected=()):
    files = []
    identities = []
    total = 0
    for name in list_private_files(root):
        if scoped(name, protected):
            info = os.stat(name, dir_fd=root, follow_symlinks=False)
            # Podman creates an unreadable, empty user-namespace-owned bind
            # target for a protected file absent from the copied source.
            # Admit only that exact mount placeholder, never protected output.
            if (name not in protected or not stat.S_ISREG(info.st_mode)
                    or info.st_size != 0 or info.st_nlink != 1
                    or info.st_uid == os.geteuid()
                    or info.st_mode & 0o077):
                raise ValueError('Protected path changed in worker output')
            identities.append((name, identity(info)))
            continue
        (size, digest, file_identity), _ = read_file(root, name)
        total += size
        if total > MAX_TOTAL_BYTES:
            raise ValueError('Private tree exceeds total limit')
        source_mode = os.stat(name, dir_fd=root, follow_symlinks=False).st_mode
        mode = 0o700 if source_mode & 0o111 else 0o600
        files.append({'path': name, 'bytes': size, 'sha256': digest,
                      'mode': format(mode, '03o')})
        identities.append((name, file_identity))
    return files, identities


def candidate_digest(attempt, revision, fingerprint, baseline, files, changes):
    material = json.dumps(['private-candidate-v1', attempt, revision, fingerprint,
                           baseline, files, changes], ensure_ascii=True,
                          separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(material).hexdigest()


def scoped(name, scopes):
    return any(name == scope or name.startswith(scope + '/') for scope in scopes)


def validate_scopes(scopes):
    if (not isinstance(scopes, list) or len(scopes) > MAX_FILES
            or len(set(scopes)) != len(scopes)
            or any(not valid_path(name) for name in scopes)):
        raise ValueError('Invalid candidate scope')


def collect(private_root, candidate_root, attempt, revision, fingerprint,
            baseline, expected_manifest, allowed, protected):
    validate_identity(attempt, revision, fingerprint)
    if not re.fullmatch(r'[a-f0-9]{64}', baseline):
        raise ValueError('Invalid baseline digest')
    validate_scopes(allowed)
    validate_scopes(protected)
    if (not allowed or not protected or
            os.path.commonpath((private_root, candidate_root)) in
            (private_root, candidate_root)):
        raise ValueError('Private and candidate storage overlap')
    if (not isinstance(expected_manifest, dict)
            or expected_manifest.get('schema') != 'stellar.private-source/v1'
            or expected_manifest.get('attemptId') != attempt
            or expected_manifest.get('sourceRevision') != revision
            or expected_manifest.get('sourceFingerprint') != fingerprint
            or expected_manifest.get('contentDigest') != baseline):
        raise ValueError('Baseline identity changed')
    baseline_files = expected_manifest.get('files')
    if (not isinstance(baseline_files, list) or len(baseline_files) > MAX_FILES
            or any(not isinstance(entry, dict) or not valid_path(entry.get('path'))
                   or not isinstance(entry.get('bytes'), int)
                   or entry['bytes'] < 0 or entry['bytes'] > MAX_FILE_BYTES
                   or not re.fullmatch(r'[a-f0-9]{64}', entry.get('sha256', ''))
                   or entry.get('mode') not in ('600', '700')
                   for entry in baseline_files)
            or [entry['path'] for entry in baseline_files] !=
            sorted({entry['path'] for entry in baseline_files})
            or manifest_digest(attempt, revision, fingerprint, baseline_files)
            != baseline):
        raise ValueError('Invalid baseline manifest')
    private_fd = open_root(private_root, private=True)
    candidate_fd = open_root(candidate_root, private=True)
    try:
        attempt_fd = os.open(attempt, OPEN_DIRECTORY, dir_fd=private_fd)
        try:
            attempt_info = os.fstat(attempt_fd)
            if (attempt_info.st_uid != os.geteuid()
                    or attempt_info.st_mode & 0o077
                    or set(os.listdir(attempt_fd)) != {'manifest.json', 'workspace'}):
                raise ValueError('Private attempt is not finalized')
            (size, _, _), chunks = read_file(attempt_fd, 'manifest.json')
            if size > 1024 * 1024 or json.loads(b''.join(chunks)) != expected_manifest:
                raise ValueError('Persisted baseline manifest changed')
            workspace_fd = os.open('workspace', OPEN_DIRECTORY, dir_fd=attempt_fd)
            try:
                workspace_info = os.fstat(workspace_fd)
                if (workspace_info.st_uid != os.geteuid()
                        or workspace_info.st_mode & 0o077):
                    raise ValueError('Unsafe private workspace')
                before, identities = file_snapshot(workspace_fd, protected)
                baseline_map = {entry['path']: entry for entry in baseline_files}
                current_map = {entry['path']: entry for entry in before}
                if any(scoped(name, protected) for name in current_map):
                    raise ValueError('Protected path appeared in worker output')
                changes = []
                for name in sorted(set(baseline_map) | set(current_map)):
                    original = baseline_map.get(name)
                    current = current_map.get(name)
                    if original == current:
                        continue
                    if not scoped(name, allowed) or scoped(name, protected):
                        raise ValueError('Worker output exceeds authorized scope')
                    changes.append({'path': name, 'status':
                                    'added' if original is None else
                                    'deleted' if current is None else 'modified'})
                if len(changes) > 100:
                    raise ValueError('Worker output exceeds change limit')
                os.mkdir(attempt, 0o700, dir_fd=candidate_fd)
                result_fd = os.open(attempt, OPEN_DIRECTORY, dir_fd=candidate_fd)
                try:
                    marker = os.open('.incomplete', os.O_WRONLY | os.O_CREAT |
                                     os.O_EXCL, 0o600, dir_fd=result_fd)
                    os.close(marker)
                    os.mkdir('workspace', 0o700, dir_fd=result_fd)
                    output_fd = os.open('workspace', OPEN_DIRECTORY, dir_fd=result_fd)
                    try:
                        for entry in before:
                            name = entry['path']
                            result, chunks = read_file(workspace_fd, name)
                            if result[2] != dict(identities)[name]:
                                raise ValueError('Worker output changed during copy')
                            write_file(output_fd, name, chunks, int(entry['mode'], 8))
                        os.fsync(output_fd)
                        copied, _ = file_snapshot(output_fd)
                        if copied != before:
                            raise ValueError('Candidate changed during copy')
                    finally:
                        os.close(output_fd)
                    after, after_identities = file_snapshot(workspace_fd, protected)
                    if before != after or identities != after_identities:
                        raise ValueError('Worker output changed during collection')
                    if (identity(workspace_info) != identity(os.fstat(workspace_fd))
                            or identity(workspace_info) != identity(os.stat(
                                'workspace', dir_fd=attempt_fd,
                                follow_symlinks=False))):
                        raise ValueError('Worker workspace changed during collection')
                    (manifest_size, _, _), manifest_chunks = read_file(
                        attempt_fd, 'manifest.json')
                    if (manifest_size > 1024 * 1024 or
                            json.loads(b''.join(manifest_chunks)) != expected_manifest):
                        raise ValueError('Baseline manifest changed during collection')
                    aggregate = candidate_digest(attempt, revision, fingerprint,
                                                 baseline, before, changes)
                    manifest = {'schema': 'stellar.private-candidate/v1',
                                'attemptId': attempt, 'sourceRevision': revision,
                                'sourceFingerprint': fingerprint,
                                'baselineDigest': baseline, 'files': before,
                                'changes': changes, 'contentDigest': aggregate}
                    encoded = json.dumps(manifest, ensure_ascii=True,
                                         separators=(',', ':')).encode('utf-8')
                    write_file(result_fd, 'manifest.json', [encoded])
                    os.rename('.incomplete', '.quarantined', src_dir_fd=result_fd,
                              dst_dir_fd=result_fd)
                    os.fsync(result_fd)
                    return manifest
                finally:
                    os.close(result_fd)
            finally:
                os.close(workspace_fd)
        finally:
            os.close(attempt_fd)
    finally:
        os.close(candidate_fd)
        os.close(private_fd)


def inspect_candidate(candidate_root, attempt, revision, fingerprint,
                      baseline, aggregate, allow_verified=False):
    validate_identity(attempt, revision, fingerprint)
    if (not re.fullmatch(r'[a-f0-9]{64}', baseline)
            or not re.fullmatch(r'[a-f0-9]{64}', aggregate)):
        raise ValueError('Invalid candidate digest')
    root_fd = open_root(candidate_root, private=True)
    try:
        attempt_fd = os.open(attempt, OPEN_DIRECTORY, dir_fd=root_fd)
        try:
            info = os.fstat(attempt_fd)
            entries = set(os.listdir(attempt_fd))
            expected = {'manifest.json', 'workspace', '.quarantined'}
            if allow_verified and 'verification.json' in entries:
                expected.add('verification.json')
            if (info.st_uid != os.geteuid() or info.st_mode & 0o077
                    or entries != expected):
                raise ValueError('Candidate is not quarantined')
            marker = os.stat('.quarantined', dir_fd=attempt_fd,
                             follow_symlinks=False)
            if not stat.S_ISREG(marker.st_mode) or marker.st_nlink != 1:
                raise ValueError('Invalid quarantine marker')
            (size, _, _), chunks = read_file(attempt_fd, 'manifest.json')
            if size > 1024 * 1024:
                raise ValueError('Candidate manifest exceeds limit')
            manifest = json.loads(b''.join(chunks))
            files = manifest.get('files')
            changes = manifest.get('changes')
            if (manifest.get('schema') != 'stellar.private-candidate/v1'
                    or manifest.get('attemptId') != attempt
                    or manifest.get('sourceRevision') != revision
                    or manifest.get('sourceFingerprint') != fingerprint
                    or manifest.get('baselineDigest') != baseline
                    or manifest.get('contentDigest') != aggregate
                    or not isinstance(files, list) or len(files) > MAX_FILES
                    or not isinstance(changes, list) or len(changes) > 100
                    or any(not isinstance(entry, dict)
                           or not valid_path(entry.get('path'))
                           or not isinstance(entry.get('bytes'), int)
                           or entry['bytes'] < 0 or entry['bytes'] > MAX_FILE_BYTES
                           or not re.fullmatch(r'[a-f0-9]{64}', entry.get('sha256', ''))
                           or entry.get('mode') not in ('600', '700')
                           for entry in files)
                    or [entry['path'] for entry in files] !=
                    sorted({entry['path'] for entry in files})
                    or any(not isinstance(entry, dict)
                           or not valid_path(entry.get('path'))
                           or entry.get('status') not in
                           ('added', 'modified', 'deleted') for entry in changes)
                    or [entry['path'] for entry in changes] !=
                    sorted({entry['path'] for entry in changes})
                    or candidate_digest(attempt, revision, fingerprint,
                                        baseline, files, changes) != aggregate):
                raise ValueError('Candidate manifest identity changed')
            workspace_fd = os.open('workspace', OPEN_DIRECTORY, dir_fd=attempt_fd)
            try:
                workspace_info = os.fstat(workspace_fd)
                if (workspace_info.st_uid != os.geteuid()
                        or workspace_info.st_mode & 0o077):
                    raise ValueError('Unsafe candidate workspace')
                actual, _ = file_snapshot(workspace_fd)
                if actual != files:
                    raise ValueError('Candidate workspace changed')
            finally:
                os.close(workspace_fd)
            return manifest
        finally:
            os.close(attempt_fd)
    finally:
        os.close(root_fd)


def accept_candidate(candidate_root, attempt, revision, fingerprint,
                     baseline, aggregate, evidence):
    inspect_candidate(candidate_root, attempt, revision, fingerprint,
                      baseline, aggregate)
    if (not isinstance(evidence, dict)
            or evidence.get('schema') != 'stellar.private-verification/v1'
            or evidence.get('attemptId') != attempt
            or evidence.get('candidateDigest') != aggregate
            or evidence.get('exitCode') != 0
            or evidence.get('terminationConfirmed') is not True
            or not isinstance(evidence.get('diagnostic'), str)
            or len(evidence['diagnostic'].encode('utf-8')) > 4096):
        raise ValueError('Invalid verification evidence')
    encoded = json.dumps(evidence, ensure_ascii=True,
                         separators=(',', ':')).encode('utf-8')
    root_fd = open_root(candidate_root, private=True)
    try:
        attempt_fd = os.open(attempt, OPEN_DIRECTORY, dir_fd=root_fd)
        try:
            write_file(attempt_fd, 'verification.json', [encoded])
            os.fsync(attempt_fd)
        finally:
            os.close(attempt_fd)
    finally:
        os.close(root_fd)
    return {'attemptId': attempt, 'candidateDigest': aggregate,
            'verificationRecorded': True}


def prepare(source, private_root, attempt, revision, fingerprint, paths, ignored):
    validate_identity(attempt, revision, fingerprint)
    if (not isinstance(paths, list) or len(paths) > MAX_FILES
            or len(set(paths)) != len(paths) or any(not valid_path(name) for name in paths)):
        raise ValueError('Invalid source manifest paths')
    if (not isinstance(ignored, list) or len(ignored) > 100_000
            or any(not isinstance(name, str) or not name.endswith('/')
                   or not valid_path(name[:-1]) for name in ignored)):
        raise ValueError('Invalid ignored-directory evidence')
    if os.path.commonpath((source, private_root)) in (source, private_root):
        raise ValueError('Source and private storage overlap')
    source_fd = open_root(source)
    private_fd = open_root(private_root, private=True)
    try:
        scan_metadata(source_fd, set(ignored))
        os.mkdir(attempt, 0o700, dir_fd=private_fd)
        attempt_fd = os.open(attempt, OPEN_DIRECTORY, dir_fd=private_fd)
        try:
            marker = os.open('.incomplete', os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                             0o600, dir_fd=attempt_fd)
            os.close(marker)
            os.mkdir('workspace', 0o700, dir_fd=attempt_fd)
            workspace_fd = os.open('workspace', OPEN_DIRECTORY, dir_fd=attempt_fd)
            files = []
            total = 0
            identities = []
            try:
                for name in sorted(paths):
                    result, chunks = read_file(source_fd, name)
                    size, digest, _ = result
                    total += size
                    if total > MAX_TOTAL_BYTES:
                        raise ValueError('Source exceeds total limit')
                    mode = 0o700 if result[2][2] & 0o111 else 0o600
                    write_file(workspace_fd, name, chunks, mode)
                    files.append({'path': name, 'bytes': size, 'sha256': digest,
                                  'mode': format(mode, '03o')})
                    identities.append((name, result))
                os.fsync(workspace_fd)
            finally:
                os.close(workspace_fd)
            for name, expected in identities:
                read_file(source_fd, name, expected)
            if identity(os.fstat(source_fd)) != identity(os.stat(source, follow_symlinks=False)):
                raise ValueError('Source root changed during copy')
            aggregate = manifest_digest(attempt, revision, fingerprint, files)
            manifest = {'schema': 'stellar.private-source/v1', 'attemptId': attempt,
                        'sourceRevision': revision, 'sourceFingerprint': fingerprint,
                        'files': files, 'contentDigest': aggregate}
            encoded = json.dumps(manifest, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
            write_file(attempt_fd, 'manifest.json', [encoded])
            os.fsync(attempt_fd)
            return manifest
        finally:
            os.close(attempt_fd)
    finally:
        os.close(private_fd)
        os.close(source_fd)


def inspect_private(private_root, attempt, revision, fingerprint, aggregate,
                    finalized):
    validate_identity(attempt, revision, fingerprint)
    if not re.fullmatch(r'[a-f0-9]{64}', aggregate):
        raise ValueError('Invalid content digest')
    private_fd = open_root(private_root, private=True)
    try:
        attempt_fd = os.open(attempt, OPEN_DIRECTORY, dir_fd=private_fd)
        try:
            attempt_info = os.fstat(attempt_fd)
            if attempt_info.st_uid != os.geteuid() or attempt_info.st_mode & 0o077:
                raise ValueError('Unsafe private attempt directory')
            expected_entries = {'manifest.json', 'workspace'}
            if not finalized:
                expected_entries.add('.incomplete')
            if set(os.listdir(attempt_fd)) != expected_entries:
                raise ValueError('Private attempt has unexpected entries')
            if not finalized:
                marker = os.stat('.incomplete', dir_fd=attempt_fd,
                                 follow_symlinks=False)
                if not stat.S_ISREG(marker.st_mode) or marker.st_nlink != 1:
                    raise ValueError('Attempt is not quarantined')
            (size, _, _), chunks = read_file(attempt_fd, 'manifest.json')
            if size > 1024 * 1024:
                raise ValueError('Manifest exceeds limit')
            manifest = json.loads(b''.join(chunks))
            files = manifest.get('files')
            if (manifest.get('schema') != 'stellar.private-source/v1'
                    or manifest.get('attemptId') != attempt
                    or manifest.get('sourceRevision') != revision
                    or manifest.get('sourceFingerprint') != fingerprint
                    or not isinstance(files, list) or len(files) > MAX_FILES
                    or manifest.get('contentDigest') != aggregate
                    or manifest_digest(attempt, revision, fingerprint, files) != aggregate):
                raise ValueError('Attempt manifest identity changed')
            if len({entry.get('path') for entry in files if isinstance(entry, dict)}) != len(files):
                raise ValueError('Duplicate private file paths')
            workspace_fd = os.open('workspace', OPEN_DIRECTORY, dir_fd=attempt_fd)
            try:
                workspace_info = os.fstat(workspace_fd)
                if (workspace_info.st_uid != os.geteuid()
                        or workspace_info.st_mode & 0o077):
                    raise ValueError('Unsafe private workspace directory')
                if list_private_files(workspace_fd) != sorted(entry['path'] for entry in files):
                    raise ValueError('Private workspace has unexpected files')
                for entry in files:
                    if (not isinstance(entry, dict) or not valid_path(entry.get('path'))
                            or not isinstance(entry.get('bytes'), int)
                            or not re.fullmatch(r'[a-f0-9]{64}', entry.get('sha256', ''))
                            or entry.get('mode') not in ('600', '700')):
                        raise ValueError('Invalid manifest entry')
                    (file_size, digest, _), _ = read_file(workspace_fd, entry['path'])
                    file_mode = os.stat(entry['path'], dir_fd=workspace_fd,
                                        follow_symlinks=False).st_mode & 0o777
                    if (file_size != entry['bytes'] or digest != entry['sha256']
                            or format(file_mode, '03o') != entry['mode']):
                        raise ValueError('Private copy changed before finalization')
            finally:
                os.close(workspace_fd)
            if finalized:
                return manifest
            os.unlink('.incomplete', dir_fd=attempt_fd)
            os.fsync(attempt_fd)
            return {'attemptId': attempt, 'contentDigest': aggregate}
        finally:
            os.close(attempt_fd)
    finally:
        os.close(private_fd)


if __name__ == '__main__':
    try:
        action = sys.argv[1]
        if action == 'prepare' and len(sys.argv) == 9:
            result = prepare(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
                             sys.argv[6], json.loads(sys.argv[7]), json.loads(sys.argv[8]))
        elif action == 'finalize' and len(sys.argv) == 7:
            result = inspect_private(*sys.argv[2:7], False)
        elif action == 'verify' and len(sys.argv) == 7:
            result = inspect_private(*sys.argv[2:7], True)
        elif action == 'collect' and len(sys.argv) == 8:
            request = globals().get('REQUEST')
            if not isinstance(request, dict):
                raise ValueError('Missing framed candidate request')
            result = collect(*sys.argv[2:8], request.get('baseline'),
                             request.get('allowed'), request.get('protected'))
        elif action == 'verify-candidate' and len(sys.argv) == 8:
            result = inspect_candidate(*sys.argv[2:8])
        elif action == 'accept-candidate' and len(sys.argv) == 9:
            result = accept_candidate(*sys.argv[2:8], json.loads(sys.argv[8]))
        else:
            raise ValueError('Invalid operation')
        print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
    except Exception:
        sys.exit('Private source capture failed.')
