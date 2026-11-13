"""Inert DB-domain errors; no exception is a receipt or retry authorization."""


class JournalError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code='journal_invalid'):
    if not condition:
        raise JournalError(code)
