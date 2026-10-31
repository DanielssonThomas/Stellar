import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectSnapshot, normalizeProfile } from './telemetry.mjs';

const now = 1_800_000_000_000;
const session = {
  id: 'private-session',
  started_at: now / 1000 - 30,
  ended_at: null,
  end_reason: null,
  last_activity_at: now / 1000 - 1,
  model: 'qwen3-coder',
  billing_provider: 'local',
  input_tokens: 10,
  output_tokens: 5,
};
const rows = {
  leases: [
    {
      conversation_id: session.id,
      holder: 'pid=100:turn=private',
      acquired_at: now / 1000 - 20,
      expires_at: now / 1000 + 30,
    },
  ],
  sessions: [session],
  messages: [
    {
      id: 1,
      session_id: session.id,
      timestamp: now / 1000 - 25,
      tool_name: 'terminal',
    },
    {
      id: 2,
      session_id: session.id,
      timestamp: now / 1000 - 2,
      tool_name: 'blender.execute_python',
    },
  ],
};

test('running requires an unexpired lease and a live holder process', () => {
  const profile = ['designer', 'Designer', 'stellar-design'];
  const active = normalizeProfile(profile, rows, {
    now,
    processAlive: (pid) => pid === 100,
  });
  assert.equal(active.state, 'running');
  assert.equal(active.activity, 'Blender');
  assert.equal(active.project, 'stellar-design');
  assert.equal(active.events.length, 2);
  assert.notEqual(active.sessionId, session.id);
  assert.equal(JSON.stringify(active).includes('private'), false);
  assert.equal(
    normalizeProfile(profile, rows, { now, processAlive: () => false }).state,
    'unknown',
  );
  assert.equal(
    normalizeProfile(
      profile,
      { ...rows, leases: [{ ...rows.leases[0], expires_at: now / 1000 - 1 }] },
      { now, processAlive: () => true },
    ).state,
    'unknown',
  );
});

test('a recent completed session is historical and stops showing tool activity', () => {
  const ended = { ...session, ended_at: now / 1000 - 20, end_reason: 'normal' };
  const agent = normalizeProfile(
    ['peon', 'Peon', 'stellar'],
    { ...rows, leases: [], sessions: [ended] },
    { now },
  );
  assert.equal(agent.state, 'completed');
  assert.equal(agent.activity, null);
  assert.equal(agent.events.at(-1).kind, 'completion');
});

test('unavailable databases are disconnected without leaking paths or errors', () => {
  const snapshot = collectSnapshot({
    root: 'C:/secret/path',
    now,
    readDatabase: () => {
      throw new Error('password=secret');
    },
  });
  assert.equal(snapshot.agents.length, 9);
  assert.ok(snapshot.agents.every((agent) => agent.state === 'disconnected'));
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
});
