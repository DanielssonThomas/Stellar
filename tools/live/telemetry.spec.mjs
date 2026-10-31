import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  collectSnapshot,
  normalizeProfile,
  readProfileDatabase,
} from './telemetry.mjs';

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

test('overlapping source queries retain each tool message once before history limiting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stellar-live-'));
  const databasePath = path.join(directory, 'state.db');
  try {
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, acquired_at REAL, expires_at REAL);
      CREATE TABLE sessions (id TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT, last_activity_at REAL, model TEXT, billing_provider TEXT, input_tokens INTEGER, output_tokens INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, timestamp REAL, tool_name TEXT);
    `);
    const time = Date.now() / 1000;
    db.prepare('INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)').run(
      'active-session',
      'pid=100:turn=fixture',
      time - 60,
      time + 60,
    );
    db.prepare(
      'INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'active-session',
      null,
      time - 60,
      null,
      null,
      time,
      'qwen3-coder',
      'local',
      30,
      10,
    );
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)');
    for (let id = 1; id <= 50; id += 1)
      insert.run(id, 'active-session', time - 51 + id, 'terminal');
    db.close();

    const observed = readProfileDatabase(databasePath);
    assert.equal(observed.messages.length, 50);
    assert.equal(
      new Set(observed.messages.map((message) => message.id)).size,
      50,
    );
    const agent = normalizeProfile(['peon', 'Peon', 'stellar'], observed, {
      now: time * 1000,
      processAlive: () => true,
    });
    assert.equal(agent.state, 'running');
    assert.equal(agent.events.length, 40);
    assert.equal(new Set(agent.events.map((event) => event.id)).size, 40);
    assert.equal(
      agent.events[0].at,
      new Date((time - 40) * 1000).toISOString(),
    );
    assert.equal(
      agent.events.at(-1).at,
      new Date((time - 1) * 1000).toISOString(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
