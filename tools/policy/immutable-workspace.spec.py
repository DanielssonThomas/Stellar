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


if __name__ == '__main__':
    unittest.main()
