"""Uninstalled development candidate; no positive native/host factory exists."""
from journal_v3.errors import JournalError


def attach(*args, **kwargs):
    """Requires a future reviewed actual guardian/connection registry, not DATA."""
    raise JournalError('host_connection_unavailable')
