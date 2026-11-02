import importlib.util
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy/workspace_credentials.py'
spec = importlib.util.spec_from_file_location('workspace_credentials', SOURCE)
credentials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(credentials)


class MemoryCredentials:
    CRED_TYPE_GENERIC = 1
    CRED_PERSIST_LOCAL_MACHINE = 2

    def __init__(self):
        self.items = {}

    def CredWrite(self, value, flags):
        self.items[value['TargetName']] = value

    def CredRead(self, name, kind, flags):
        item = self.items[name]
        blob = item['CredentialBlob']
        return {**item, 'CredentialBlob': blob.encode('utf-16-le') if type(blob) is str else blob}


class WorkspaceCredentialTests(unittest.TestCase):
    def test_unique_reference_and_bearer_round_trip_without_plaintext_reference(self):
        adapter = MemoryCredentials()
        store = credentials.WorkspaceCredentials(adapter)
        reference, token = store.create()
        second_reference, second_token = store.create()
        self.assertNotEqual(reference, second_reference)
        self.assertNotEqual(token, second_token)
        self.assertNotIn(token, reference)
        self.assertEqual(store.read(reference), token)
        self.assertEqual(set(adapter.items), {credentials.PREFIX + reference, credentials.PREFIX + second_reference})

    def test_missing_malformed_or_corrupt_credentials_fail_closed(self):
        adapter = MemoryCredentials()
        store = credentials.WorkspaceCredentials(adapter)
        for reference in ('../foreign', 'A' * 32, '0' * 32):
            with self.subTest(reference=reference), self.assertRaises(credentials.CredentialUnavailable):
                store.read(reference)
        reference, _ = store.create()
        adapter.items[credentials.PREFIX + reference]['CredentialBlob'] = b'not-a-token'
        with self.assertRaises(credentials.CredentialUnavailable):
            store.read(reference)


if __name__ == '__main__':
    unittest.main()
