"""Explicit observation consent and bounded reconciliation; notification is unavailable."""
from __future__ import annotations

import hashlib
import json
import time

from .core import ROLES, Unavailable
from .observation_sources import KINDS, snapshot, validate_receipt
from .observation_store import ObservationStore


def receipt_for(root, issue, role, session):
    from .workers import SESSION
    if (type(issue) is not int or not 1 <= issue <= 2**31 - 1 or role not in ROLES or
            type(session) is not str or not SESSION.fullmatch(session)):
        raise Unavailable('Specify the exact issue, worker and launch claim session for tracking.')
    fingerprint = hashlib.sha256(session.encode('utf-8')).hexdigest()
    try:
        row = json.loads((root / 'attempts' / f'{issue}-{fingerprint}' / 'terminal.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise Unavailable('The confirmed launch receipt is unavailable.') from None
    receipt = validate_receipt(row)
    if (receipt['issue'], receipt['role'], receipt['claim_session']) != (issue, role, session):
        raise Unavailable('The launch receipt does not match the requested work.')
    return receipt


def reconcile(store, settings, core, *, clock=time.time, tracks=None):
    count = 0
    # One source attempt per reservation, at most four tracks per scheduler tick.
    for _ in range(4):
        reserved = (store.reserve(clock()) if tracks is None
                    else store.reserve(clock(), tracks=tracks))
        if reserved is None:
            break
        try:
            receipt = validate_receipt(json.loads(reserved['receipt']))
            facts = snapshot(settings, core, receipt, clock=clock)
        except Unavailable:
            facts = None
        store.finish(reserved, facts, clock())
        count += 1
    return {'reconciled': count, 'delivery': 'blocked_supported_session_bound_producer_required'}


def operate_observation(root, settings, core, args):
    store = ObservationStore(root)
    if args['action'] == 'observations':
        return store.status(time.time())
    if args['action'] == 'reconcile':
        return reconcile(store, settings, core)
    issue = args.get('issue')
    if type(issue) is not int or not 1 <= issue <= 2**31 - 1 or type(args.get('enabled')) is not bool:
        raise Unavailable('Tracking requires an issue and explicit enabled true or false.')
    if not args['enabled']:
        store.disable(issue)
        from .notification_store import NotificationStore
        bound = NotificationStore(root)
        bound.sync(time.time())
        phases = bound.summary(time.time())['notification_bindings']
        return {'issue': issue, 'tracking': False,
                'delivery': 'revoke_pending' if phases.get('revoke_pending') else 'disabled'}
    receipt = receipt_for(root, issue, args.get('role'), args.get('session_id'))
    expected_revision = store.consent_revision()
    facts = snapshot(settings, core, receipt)
    revision = store.enable(receipt, args.get('kinds', list(KINDS)), facts, time.time(), expected_revision)
    return {'issue': issue, 'tracking': True, 'revision': revision,
            'delivery': 'blocked_supported_session_bound_producer_required'}
