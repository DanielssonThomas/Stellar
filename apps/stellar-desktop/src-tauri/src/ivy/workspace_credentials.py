"""Private, per-foreground bearer storage using the installed Windows credential wrapper."""
from __future__ import annotations

import re
import secrets

PREFIX = 'Stellar/WorkspaceMcp/'
REFERENCE = re.compile(r'^[0-9a-f]{32}$', re.ASCII)
TOKEN = re.compile(r'^[A-Za-z0-9_-]{43}$', re.ASCII)


class CredentialUnavailable(Exception):
    pass


class WorkspaceCredentials:
    def __init__(self, adapter):
        self.adapter = adapter

    def create(self):
        reference = secrets.token_hex(16)
        token = secrets.token_urlsafe(32)
        try:
            self.adapter.CredWrite({
                'Type': self.adapter.CRED_TYPE_GENERIC,
                'TargetName': PREFIX + reference,
                'CredentialBlob': token,
                'Persist': self.adapter.CRED_PERSIST_LOCAL_MACHINE,
                'UserName': 'Stellar Workspace',
            }, 0)
        except Exception:
            raise CredentialUnavailable() from None
        return reference, token

    def read(self, reference):
        if type(reference) is not str or REFERENCE.fullmatch(reference) is None:
            raise CredentialUnavailable()
        try:
            result = self.adapter.CredRead(PREFIX + reference, self.adapter.CRED_TYPE_GENERIC, 0)
            token = result['CredentialBlob'].decode('utf-16-le')
        except Exception:
            raise CredentialUnavailable() from None
        if TOKEN.fullmatch(token) is None:
            raise CredentialUnavailable()
        return token
