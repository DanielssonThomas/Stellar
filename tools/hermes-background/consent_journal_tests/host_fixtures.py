"""Synthetic DATA only: no authenticated connection, OS callback or real ticket."""
from .fixtures import Fixture
from host_connection_v3._plan import _ConnectionPlan


class HostFixture(Fixture):
    def setUp(self):
        super().setUp()
        self.original_fixture = object()
        self.mono_fixture = 1000
        self.ticket_data_fixture = '57' * 32
        self.plan = self.new_plan()

    def new_plan(self):
        return _ConnectionPlan(self.db, self.original_fixture, self.context, self.scope,
            wall_ms=lambda: self.now, monotonic_ms=lambda: self.mono_fixture)

    def call(self, method, *args, original=None, context=None, prepared=None):
        return getattr(self.plan, method)(self.original_fixture if original is None else original,
            self.context if context is None else context, self.scope if prepared is None else prepared, *args)

    def prepare_host(self, phase='released', deadline=None):
        self.call('reserve')
        if phase == 'pending': return
        self.call('begin')
        if phase == 'confirming': return
        self.call('reserve_issue', self.intent)
        if phase == 'issuing': return
        self.call('record_ticket', self.intent, self.ticket_data_fixture,
            self.now + 10000 if deadline is None else deadline)
        if phase == 'issued': return
        self.assertEqual(self.call('release'), self.ticket_data_fixture)

    def bind_host(self):
        return self.call('bind', self.ticket_data_fixture)

    def cancel_host(self):
        return self.plan.cancel(self.original_fixture)
