"""Fence canonical writer callback re-entry, including post-callback commit errors."""
from .errors import JournalError
from threading import Lock


def once(callback):
    entered = False
    lock = Lock()

    def guarded(*args, **kwargs):
        nonlocal entered
        with lock:
            if entered:
                raise JournalError('write_uncertain')
            entered = True
        return callback(*args, **kwargs)
    return guarded


def write_once(db, callback):
    return db._execute_write(once(callback))


class OneShotWriter:
    """Data-only delegation for a Ledger composition, not DB/native authority.

    Guards entry BEFORE the existing Ledger callback's first INSERT, not merely
    its later _on_bind hook. The wrapped SessionDB still owns lock/commit/rollback.
    """
    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        return getattr(self._db, name)

    def _execute_write(self, callback, *args, **kwargs):
        return self._db._execute_write(once(callback), *args, **kwargs)
