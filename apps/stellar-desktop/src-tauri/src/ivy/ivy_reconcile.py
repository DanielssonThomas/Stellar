"""Connection-owned scheduling of the producer's existing reconciliation operation."""
import asyncio
import contextlib

from stellar_ivy_controls import Refused

INTERVAL = 60
METHOD = 'plugin.stellar-herdr.observations.reconcile'


def summary(value):
    if (type(value) is not dict or set(value) != {'reconciled', 'delivery', 'notifications'}
            or value['delivery'] != 'notification_admission_only'
            or type(value['reconciled']) is not int or not 0 <= value['reconciled'] <= 4):
        raise ValueError('notification_reconcile_shape')
    counts = value['notifications']
    if (type(counts) is not dict or set(counts) != {'known', 'unknown', 'suppressed'}
            or any(type(v) is not int or not 0 <= v <= 4 for v in counts.values())
            or sum(counts.values()) > 4):
        raise ValueError('notification_reconcile_counts')
    return {'reconciled': value['reconciled'], 'delivery': value['delivery'],
            'notifications': dict(counts)}


class Reconciler:
    def __init__(self, conn, deadline, diagnostic, *, clock=None, sleep=asyncio.sleep):
        self.conn, self.client = conn, conn.client
        self.deadline, self.diagnostic = deadline, diagnostic
        self.clock = clock or asyncio.get_running_loop().time
        self.sleep = sleep
        self.changed = asyncio.Event()
        self.session = None
        self.generation = 0
        self.next_due = self.clock() + INTERVAL
        self.busy = self.closed = self.suspended = False
        self.last_error = None
        self.runner = None

    def select(self, session):
        if self.closed:
            return
        if type(session) is not str or not session or len(session.encode('utf-8')) > 512:
            raise ValueError('notification_reconcile_session')
        self.session, self.suspended = session, False
        self.invalidate()

    def invalidate(self):
        self.generation += 1
        self.next_due = self.clock() + INTERVAL
        self.changed.set()

    def pause(self):
        self.session = None
        self.invalidate()

    def current(self, session, generation):
        return (not self.closed and not self.suspended and self.session == session
                and self.generation == generation and self.conn.client is self.client
                and getattr(self.conn, 'selected_session', None) == session)

    async def forward(self, params):
        session, generation = self.session, self.generation
        if (type(params) is not dict or set(params) != {'session_id'} or session is None
                or params['session_id'] != session or not self.current(session, generation)):
            raise Refused('unavailable')
        if self.busy or self.clock() < self.next_due:
            raise Refused('busy')
        self.busy = True
        try:
            value = await asyncio.wait_for(self.client.rpc(METHOD, session_id=session), self.deadline)
            result = summary(value)
            if not self.current(session, generation):
                raise Refused('unavailable')
            self.last_error = None
            return result
        except asyncio.CancelledError:
            self.suspended, self.last_error = True, 'outcome_uncertain'
            raise
        except Refused:
            raise
        except Exception as error:
            self.last_error = 'deadline' if isinstance(error, asyncio.TimeoutError) else self.diagnostic(error)
            # A received gateway error ended that RPC. A future periodic reconciliation
            # still delegates UNKNOWN handling to the producer, never to an event resend.
            if isinstance(error, getattr(self.conn, 'rpc_error_type', ())):
                raise Refused('unavailable') from None
            self.suspended = True
            raise Refused('outcome_uncertain') from None
        finally:
            self.busy = False
            self.next_due = max(self.next_due, self.clock() + INTERVAL)
            self.changed.set()

    async def wait(self, delay):
        sleeper = asyncio.create_task(self.sleep(delay))
        changed = asyncio.create_task(self.changed.wait())
        try:
            await asyncio.wait((sleeper, changed), return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (sleeper, changed):
                task.cancel()
            for task in (sleeper, changed):
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def run(self):
        if self.runner is not None:
            raise RuntimeError('notification_reconcile_owner')
        self.runner = asyncio.current_task()
        while not self.closed:
            self.changed.clear()
            session, generation = self.session, self.generation
            if session is None or not self.current(session, generation):
                await self.changed.wait()
                continue
            delay = self.next_due - self.clock()
            if self.busy or delay > 0:
                await self.wait(max(0, delay) if not self.busy else INTERVAL)
                continue
            try:
                await self.forward({'session_id': session})
            except Refused:
                pass  # Private failure state cannot settle or abort foreground work.

    async def close(self):
        self.closed = True
        self.pause()
        if self.runner is not None and self.runner is not asyncio.current_task():
            self.runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.runner
