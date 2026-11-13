"""Forward verified observations through the supported candidate ctx API, never human input."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time

from .core import Core, Unavailable
from .notification_store import NotificationStore
from .observation import operate_observation, reconcile
from .observation_store import ObservationStore
from .workers import load, operate


class NotificationProducer:
    def __init__(self, profile, ctx, *, clock=time.time):
        self.profile = Path(profile)
        self.ctx = ctx
        self.clock = clock

    def store(self):
        root, settings = load(self.profile)
        return NotificationStore(root), settings

    async def call(self, action, **params):
        method = getattr(self.ctx, 'notification', None)
        if not callable(method):
            raise Unavailable('The runtime has no supported notification admission API; delivery is unavailable.')
        return await method(action, **params)

    @staticmethod
    def validate(saved, response):
        if not isinstance(response, dict) or response.get('status') not in ('known', 'unknown'):
            raise Unavailable('The notification host returned an invalid inspection.')
        binding = json.loads(saved['binding'])
        if response.get('binding') != binding or response.get('event_id') != saved['event_id']:
            raise Unavailable('The host inspection names another original event or session.')
        if type(response.get('delivery_allowed')) is not bool:
            raise Unavailable('The host inspection has no explicit eligibility state.')
        if response['status'] == 'unknown':
            if response['delivery_allowed']:
                raise Unavailable('Unknown admission cannot authorize delivery.')
            return False
        receipt = response.get('receipt')
        if (not isinstance(receipt, dict) or not isinstance(receipt.get('admission_id'), str)
                or not receipt['admission_id'] or receipt.get('ref') != {
                    'profile_id': binding['profile_id'], 'session_id': binding['owner_session_id']}
                or type(receipt.get('sequence')) is not int or receipt['sequence'] < 1
                or type(receipt.get('authority_epoch')) is not int or receipt['authority_epoch'] < 1
                or receipt.get('status') not in ('queued', 'started', 'unknown', 'terminal')):
            raise Unavailable('Canonical notification receipt correlation failed.')
        generation = receipt.get('execution_generation')
        status, outcome = receipt['status'], receipt.get('outcome')
        if ((status == 'queued' and generation is not None)
                or (generation is not None and (type(generation) is not int or generation < 1))
                or (status in ('started', 'unknown') and generation is None)
                or (status != 'terminal' and outcome is not None)
                or (status == 'terminal' and outcome not in ('completed', 'cancelled', 'failed', 'interrupted', 'rejected'))
                or (status == 'terminal' and outcome != 'cancelled' and generation is None)
                or (response['delivery_allowed'] and (status, outcome) != ('terminal', 'completed'))):
            raise Unavailable('The canonical notification execution state is inconsistent.')
        notice = response.get('descriptor')
        expected = {'schema_version': 1, 'binding': binding, 'event_id': saved['event_id'],
                    'payload_digest': hashlib.sha256(saved['content'].encode('utf-8')).hexdigest()}
        if notice is not None and notice != expected:
            raise Unavailable('The host notification descriptor conflicts with retained evidence.')
        if notice is None and response.get('delivery_allowed') is not False:
            raise Unavailable('Retired notification provenance cannot authorize delivery.')
        return True

    async def revoke_one(self, store, saved):
        binding = json.loads(saved['binding'])
        try:
            response = await self.call('revoke', binding=binding)
            if (not isinstance(response, dict) or response.get('binding') != binding
                    or response.get('revoked') is not True or type(response.get('in_flight')) is not list):
                raise Unavailable('The host did not confirm this binding revocation.')
            store.revoked(saved, response)
            return response
        except Exception:
            return None  # retained revoke_pending, never a successful-stop receipt

    async def revoke_pending(self, store, *, issue=None, session_id=None):
        pending = store.pending_revokes(self.clock(), issue=issue, session_id=session_id)
        return [await self.revoke_one(store, saved) for saved in pending]

    async def event(self, store, event_id):
        first = store.reserve_event(event_id, self.clock())
        saved = store.lookup(event_id)
        if saved is None:
            return 'suppressed'
        binding = json.loads(saved['binding'])
        response = await self.call('inspect', binding=binding, event_id=event_id)
        if not self.validate(saved, response):
            # Unknown permits the SOLE initial submission, never a retry/takeover.
            if not first or not store.eligible(event_id, self.clock()):
                return 'unknown'
            response = await self.call('admit', binding=binding, event_id=event_id, content=saved['content'])
            if not self.validate(saved, response):
                return 'unknown'
        store.remember(event_id, response)
        return 'known'  # admission/result known, NOT delivered/rendered/spoken

    async def tick(self, store, *, session_id=None):
        await self.revoke_pending(store, session_id=session_id)
        results = {'known': 0, 'unknown': 0, 'suppressed': 0}
        for event_id in store.candidates(self.clock(), session_id=session_id):
            try:
                state = await self.event(store, event_id)
            except Exception:
                state = 'unknown'  # do not overwrite a known admission or free an UNKNOWN attempt
            results[state] += 1
        return results

    @staticmethod
    def same_tracking(current, expected):
        return current is not None and expected is not None and all(
            current[key] == expected[key] for key in ('incarnation', 'revision', 'issue', 'receipt', 'expires'))

    async def handle(self, args):
        action = args.get('action')
        if action not in ('tracking', 'reconcile', 'observations'):
            return operate(self.profile, args)
        store, settings = self.store()
        if action == 'observations':
            return {**store.status(self.clock()), 'delivery': 'observation_and_notification_bookkeeping',
                    'notification_bookkeeping': store.summary(self.clock())}
        if action == 'reconcile':
            observed = reconcile(ObservationStore(store.path.parent), settings, Core(settings), clock=self.clock)
            return {**observed, 'delivery': 'notification_admission_only', 'notifications': await self.tick(store)}
        result = operate_observation(store.path.parent, settings, Core(settings), args)
        track = store.current(args['issue']) if args.get('enabled') else None
        if args.get('enabled') and (track is None or track['revision'] != result['revision']):
            return {**result, 'tracking': False, 'delivery': 'tracking_changed_before_binding'}
        await self.revoke_pending(store, issue=args.get('issue'))
        if not args.get('enabled'):
            return {**result, 'delivery': 'revocation_reconciled_or_pending',
                    'notification_bookkeeping': store.summary(self.clock())}
        if not self.same_tracking(store.current(args['issue']), track):
            return {**result, 'tracking': False, 'delivery': 'tracking_changed_before_binding'}
        try:
            binding = await self.call('bind', tracking_id=track['incarnation'], revision=track['revision'],
                                      expires_at=track['expires'])
            if (not isinstance(binding, dict) or binding.get('tracking_id') != track['incarnation']
                    or binding.get('revision') != track['revision'] or binding.get('expires_at') != track['expires']
                    or not isinstance(binding.get('profile_id'), str)
                    or Path(binding['profile_id']).resolve() != self.profile.resolve()):
                raise Unavailable('The host did not bind this profile and exact tracking revision.')
            store.save_binding(track, binding, self.clock())
            await self.revoke_pending(store, issue=args['issue'])  # opt-out may have won while bind awaited
            if not self.same_tracking(store.current(args['issue']), track):
                return {**result, 'tracking': False, 'delivery': 'tracking_changed_binding_revoked_or_pending',
                        'binding': binding}
            return {**result, 'delivery': 'bound_notification_admission', 'binding': binding}
        except Exception:
            if not self.same_tracking(store.current(args['issue']), track):
                return {**result, 'tracking': False, 'delivery': 'tracking_changed_binding_unknown'}
            return {**result, 'delivery': 'binding_unknown_or_unsupported_no_notification_sent'}

    def authorized_event(self, params, server_session_id):
        if (type(params) is not dict or set(params) - {'session_id', 'event_id'}
                or type(server_session_id) is not str or not server_session_id
                or ('session_id' in params and params['session_id'] != server_session_id)
                or type(params.get('event_id')) is not str or len(params['event_id']) != 64
                or any(char not in '0123456789abcdef' for char in params['event_id'])):
            raise Unavailable('A server-authorized session and exact observed event are required.')
        store, _ = self.store()
        saved = store.lookup(params['event_id'])
        if saved is None or json.loads(saved['binding']).get('owner_session_id') != server_session_id:
            raise Unavailable('The observed event does not belong to this authorized session.')
        return store, saved

    async def rpc_inspect(self, params, *, session_id=None, **_kwargs):
        store, saved = self.authorized_event(params, session_id)
        response = await self.call('inspect', binding=json.loads(saved['binding']), event_id=saved['event_id'])
        known = self.validate(saved, response)
        if known:
            store.remember(saved['event_id'], response)
        local = store.eligible(saved['event_id'], self.clock())  # AFTER host await; local opt-out wins
        final = ((response.get('result') or {}).get('result') or {}).get('final_response')
        meaningful = type(final) is str and bool(final.strip()) and len(final.encode('utf-8')) <= 262144
        return {'host': response, 'local_eligible': local,
                'delivery_allowed': known and local and response.get('delivery_allowed') is True and meaningful}

    async def rpc_revoke(self, params, *, session_id=None, **_kwargs):
        store, saved = self.authorized_event(params, session_id)
        store.disable_binding(saved)
        outcome = await self.revoke_one(store, saved)
        return {'event_id': saved['event_id'], 'tracking': False,
                'revocation': outcome, 'state': 'revoked' if outcome is not None else 'revoke_pending'}

    async def rpc_reconcile(self, params, *, session_id=None, **_kwargs):
        if (type(params) is not dict or set(params) - {'session_id'}
                or type(session_id) is not str or not session_id
                or ('session_id' in params and params['session_id'] != session_id)):
            raise Unavailable('A server-authorized original session is required.')
        store, settings = self.store()
        scope = store.active_scope(session_id)
        if scope is None:
            raise Unavailable('This authorized session has no retained notification binding.')
        observed = reconcile(ObservationStore(store.path.parent), settings, Core(settings),
                             clock=self.clock, tracks=scope)
        return {**observed, 'delivery': 'notification_admission_only',
                'notifications': await self.tick(store, session_id=session_id)}
