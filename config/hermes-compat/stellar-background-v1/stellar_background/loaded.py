"""Reject stale/foreign already-loaded host call sites; disk hashes alone do not prove code."""
from __future__ import annotations

from pathlib import Path
import sys
from types import CodeType

from .contract import ContractError

POINTS = {
    'hermes_state_runtime': ('claim_session_input', 'settle_session_input', 'resolve_unknown_session_input'),
    'gateway.session_authority': ('SessionAuthority._claim_next', 'SessionAuthority._stamp_claim', 'SessionAuthority._settle_cancelled'),
    'gateway.session_controls': ('AuthorityConnection.dispatch', 'AuthorityConnection.receipt', 'AuthorityConnection.describe'),
    'gateway.session_results': ('finish_result',),
    'gateway.session_automation': ('admission_display', 'restore_local_automation'),
    'gateway.session_settlement_recovery': ('completion_payload', '_publish_completion'),
    'hermes_cli.plugins_context': ('PluginContext.background_v1',),
}


def _codes(code):
    values = {code.co_qualname: code}
    for child in code.co_consts:
        if isinstance(child, CodeType):
            values.update(_codes(child))
    return values


def verify_loaded(root):
    checked = []
    for name, points in POINTS.items():
        module = sys.modules.get(name)
        if module is None:
            if name == 'hermes_state_runtime':
                raise ContractError('loaded_runtime_mismatch')
            continue  # not claimed qualified; a later start must load the pinned disk image
        filename = getattr(module, '__file__', None)
        if filename is None or Path(filename).resolve() != root / (name.replace('.', '/') + '.py'):
            raise ContractError('loaded_runtime_mismatch')
        expected = _codes(compile(Path(filename).read_text(encoding='utf-8'), filename, 'exec', dont_inherit=True))
        for point in points:
            target = module
            for part in point.split('.'):
                target = getattr(target, part, None)
            target = target.fget if isinstance(target, property) else target
            if getattr(target, '__code__', None) != expected.get(point):
                raise ContractError('loaded_runtime_mismatch')
            checked.append(name + ':' + point)
    return checked
