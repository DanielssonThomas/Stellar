"""Inactive host compatibility candidate. No registration, patching, discovery or side effects."""

from .contract import CAPABILITY, ContractError, Origin, event_digest
from .ledger import Ledger

__all__ = ['CAPABILITY', 'ContractError', 'Origin', 'event_digest', 'Ledger']
