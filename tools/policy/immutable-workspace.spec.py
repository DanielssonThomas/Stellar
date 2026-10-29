"""Offline tests for root-only primitives, run under WSL Python without root."""

import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name('immutable-workspace.py')
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('immutable_workspace', SCRIPT)
WORKSPACE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKSPACE)


class ImmutableWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'AGENTS.md').write_text('protected')
        (self.repo / 'src').mkdir()
        (self.repo / 'src' / 'file.txt').write_text('base')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        self.revision = self.git('rev-parse', 'HEAD').strip()
        self.root_check = mock.patch.object(WORKSPACE, 'ensure_root')
        self.root_check.start()
        self.addCleanup(self.root_check.stop)
        self.parent_check = mock.patch.object(
            WORKSPACE, 'trusted_parent',
            side_effect=lambda destination: (os.path.abspath(destination), os.path.dirname(os.path.abspath(destination))))
        self.parent_check.start()
        self.addCleanup(self.parent_check.stop)
        self.seal_check = mock.patch.object(WORKSPACE, 'assert_root_seal')
        self.seal_check.start()
        self.addCleanup(self.seal_check.stop)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args],
                                       text=True, stderr=subprocess.DEVNULL)

    def source(self):
        manifest = WORKSPACE.write_tree(str(self.root / 'source'),
                                        WORKSPACE.git_source(str(self.repo), self.revision),
                                        {'kind': 'git', 'revision': self.revision})
        self.assertEqual(WORKSPACE.verify(str(self.root / 'source'),
                                          str(self.root / 'source.json')),
                         manifest['digest'])
        return manifest

    def output(self):
        volume = self.root / 'volume'
        volume.mkdir()
        (volume / 'src').mkdir()
        (volume / 'AGENTS.md').write_text('protected')
        (volume / 'src' / 'file.txt').write_text('changed')
        return volume

    def test_clean_pinned_git_capture_and_candidate(self):
        self.source()
        volume = self.output()
        candidate = WORKSPACE.collect(str(volume), str(self.root / 'source.json'),
                                      str(self.root / 'candidate'), ['src'], ['AGENTS.md'])
        self.assertEqual(candidate['source']['changedPaths'], ['src/file.txt'])
        self.assertEqual(WORKSPACE.verify(str(self.root / 'candidate'),
                                          str(self.root / 'candidate.json')),
                         candidate['digest'])

    def test_dirty_or_suppressed_index_cannot_enter_capture(self):
        (self.repo / 'src' / 'file.txt').write_text('dirty')
        with self.assertRaises(ValueError):
            WORKSPACE.git_source(str(self.repo), self.revision)
        self.git('checkout', '--', 'src/file.txt')
        self.git('update-index', '--assume-unchanged', '--', 'src/file.txt')
        with self.assertRaises(ValueError):
            WORKSPACE.git_source(str(self.repo), self.revision)

    def test_explicit_dirty_untracked_and_ignored_inputs_are_digest_bound(self):
        source = self.repo / 'src' / 'file.txt'
        source.write_text('dirty')
        extra = self.repo / 'src' / 'new.txt'
        extra.write_text('new')
        (self.repo / '.gitignore').write_text('cache/\n')
        # The ignore rule itself is a dirty untracked input.
        ignored = self.repo / 'cache' / 'needed.txt'
        ignored.parent.mkdir()
        ignored.write_text('dependency')
        changes = [
            {'path': 'src/file.txt', 'sha256': WORKSPACE.digest(b'dirty'),
             'executable': False, 'ignored': False},
            {'path': 'src/new.txt', 'sha256': WORKSPACE.digest(b'new'),
             'executable': False, 'ignored': False},
            {'path': '.gitignore', 'sha256': WORKSPACE.digest(b'cache/\n'),
             'executable': False, 'ignored': False},
            {'path': 'cache/needed.txt', 'sha256': WORKSPACE.digest(b'dependency'),
             'executable': False, 'ignored': True},
        ]
        captured = WORKSPACE.git_source(str(self.repo), self.revision, changes)
        self.assertEqual({name for name, _, _ in captured},
                         {'AGENTS.md', '.gitignore', 'src/file.txt', 'src/new.txt', 'cache/needed.txt'})
        extra.write_text('changed after authorization')
        with self.assertRaises(ValueError):
            WORKSPACE.git_source(str(self.repo), self.revision, changes)

    def test_git_output_limit_is_enforced_while_running(self):
        with self.assertRaises(ValueError):
            WORKSPACE.command('git', 'ls-tree', '-r', '-z', self.revision,
                              cwd=str(self.repo), limit=4)

    def test_fsmonitor_hook_is_not_executed_during_capture(self):
        marker = self.root / 'hook-ran'
        hook = self.repo / '.git' / 'hooks' / 'fsmonitor'
        hook.write_text('#!/bin/sh\nprintf invoked > "{}"\n'.format(marker))
        hook.chmod(0o755)
        self.git('config', 'core.fsmonitor', str(hook))
        captured = WORKSPACE.git_source(str(self.repo), self.revision)
        self.assertIn('src/file.txt', [name for name, _, _ in captured])
        self.assertFalse(marker.exists())

    def test_replacement_ref_cannot_substitute_pinned_commit(self):
        blob = subprocess.check_output(
            ['git', '-C', str(self.repo), 'hash-object', '-w', '--stdin'],
            input=b'injected', stderr=subprocess.DEVNULL).decode().strip()
        tree = subprocess.check_output(
            ['git', '-C', str(self.repo), 'mktree'],
            input=('100644 blob {}\tinjected.txt\n'.format(blob)).encode(),
            stderr=subprocess.DEVNULL).decode().strip()
        replacement = self.git('commit-tree', tree).strip()
        self.git('replace', self.revision, replacement)
        # Ordinary Git sees the substituted tree; hardened capture must see the original.
        self.assertIn('injected.txt', self.git('ls-tree', '-r', '--name-only', self.revision))
        captured = WORKSPACE.git_source(str(self.repo), self.revision)
        self.assertEqual({name for name, _, _ in captured},
                         {'AGENTS.md', 'src/file.txt'})

    def test_empty_directories_and_source_blobs_obey_aggregate_limits(self):
        volume = self.root / 'many-directories'
        volume.mkdir()
        for number in range(3):
            (volume / str(number)).mkdir()
        with mock.patch.object(WORKSPACE, 'MAX_FILES', 2):
            with self.assertRaises(ValueError):
                WORKSPACE.read_tree(str(volume))
        with mock.patch.object(WORKSPACE, 'MAX_TOTAL', 3):
            with self.assertRaises(ValueError):
                WORKSPACE.git_source(str(self.repo), self.revision)

    def test_symlink_hardlink_and_protected_output_rejected(self):
        self.source()
        volume = self.output()
        os.symlink('/etc/passwd', volume / 'src' / 'leak')
        with self.assertRaises(ValueError):
            WORKSPACE.collect(str(volume), str(self.root / 'source.json'),
                              str(self.root / 'candidate'), ['src'], ['AGENTS.md'])
        (volume / 'src' / 'leak').unlink()
        os.link(volume / 'src' / 'file.txt', volume / 'src' / 'linked')
        with self.assertRaises(ValueError):
            WORKSPACE.collect(str(volume), str(self.root / 'source.json'),
                              str(self.root / 'candidate'), ['src'], ['AGENTS.md'])
        (volume / 'src' / 'linked').unlink()
        (volume / 'AGENTS.md').write_text('tampered')
        with self.assertRaises(ValueError):
            WORKSPACE.collect(str(volume), str(self.root / 'source.json'),
                              str(self.root / 'candidate'), ['src'], ['AGENTS.md'])

    def test_stale_manifest_or_tree_rejected(self):
        self.source()
        volume = self.output()
        (self.root / 'source' / 'src' / 'file.txt').chmod(0o600)
        (self.root / 'source' / 'src' / 'file.txt').write_text('mutated')
        with self.assertRaises(ValueError):
            WORKSPACE.collect(str(volume), str(self.root / 'source.json'),
                              str(self.root / 'candidate'), ['src'], ['AGENTS.md'])

    def test_authorization_cannot_include_protected_path(self):
        self.source()
        volume = self.output()
        with self.assertRaises(ValueError):
            WORKSPACE.collect(str(volume), str(self.root / 'source.json'),
                              str(self.root / 'candidate'), ['AGENTS.md'], ['AGENTS.md'])

    def test_interrupted_snapshot_publication_is_quarantined(self):
        destination = self.root / 'interrupted'
        destination.mkdir()
        state = WORKSPACE.inspect_publication(str(destination))
        self.assertTrue(state['tree'])
        self.assertFalse(state['manifest'])
        self.assertFalse(state['safeToConsume'])
        with self.assertRaises(ValueError):
            WORKSPACE.write_tree(str(destination), [], {'kind': 'test'})
        pending = self.root / 'pending.pending'
        pending.mkdir()
        self.assertTrue(WORKSPACE.inspect_publication(str(self.root / 'pending'))['pendingTree'])


if __name__ == '__main__':
    unittest.main()
