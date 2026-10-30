import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readHermesStatus, readGithubStatus } from './status-adapter.mjs';
import { createStatusServer } from './status-server.mjs';

test('reads only allowlisted profile fields and aggregate session facts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stellar-status-'));
  const profile = path.join(root, 'profiles', 'architect-cloud');
  await mkdir(profile, { recursive: true });
  await writeFile(
    path.join(profile, 'config.yaml'),
    'model:\n  default: "gpt-6.1-sol"\n  provider: openai-codex\nsecret: DO_NOT_EXPOSE\n',
  );
  const db = new DatabaseSync(path.join(profile, 'state.db'));
  db.exec(
    'CREATE TABLE sessions (last_activity_at REAL, end_reason TEXT); CREATE TABLE session_model_usage (input_tokens INTEGER, output_tokens INTEGER, api_call_count INTEGER)',
  );
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(1793394000, 'completed');
  db.prepare('INSERT INTO session_model_usage VALUES (?, ?, ?)').run(100, 5, 1);
  db.close();
  try {
    const profiles = await readHermesStatus(root);
    assert.equal(profiles.length, 8);
    assert.equal(profiles[0].model, 'gpt-6.1-sol');
    assert.equal(profiles[0].sessionCount, 1);
    assert.equal(profiles[0].sessionState, 'recorded');
    assert.equal(profiles[0].usage.apiCalls, 1);
    assert.equal(profiles[1].model, 'Unavailable');
    assert.equal(profiles[1].sessionState, 'unavailable');
    assert.ok(!JSON.stringify(profiles).includes('DO_NOT_EXPOSE'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maps public GitHub issue and pull request metadata without credentials', async () => {
  const fetcher = async (url) => ({
    ok: true,
    json: async () =>
      url.includes('/pulls?')
        ? [
            {
              number: 12,
              title: 'Review',
              html_url: 'https://github.com/example/pr/12',
              draft: false,
            },
          ]
        : [
            {
              number: 10,
              title: 'Blocked issue',
              html_url: 'https://github.com/example/issues/10',
              labels: [{ name: 'status:blocked' }, { name: 'owner:codex' }],
            },
          ],
  });
  const status = await readGithubStatus(fetcher);
  assert.equal(status.issues[0].blocked, true);
  assert.equal(status.issues[0].owner, 'owner:codex');
  assert.equal(status.pulls[0].number, 12);
});

test('bounds a stalled GitHub feed without blocking local observations indefinitely', async () => {
  const stalled = (_url, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(readGithubStatus(stalled, 20), {
      name: 'TimeoutError',
    });
  } finally {
    clearTimeout(keepAlive);
  }
});

test('HTTP adapter accepts only its fixed read-only status route', async () => {
  const server = createStatusServer(async () => ({
    observedAt: 'test',
    agents: [],
    github: { state: 'unavailable', issues: [], pulls: [] },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    const allowed = await fetch(`${base}/api/status`, {
      headers: { Origin: 'http://127.0.0.1:4200' },
    });
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      'http://127.0.0.1:4200',
    );
    const denied = await fetch(`${base}/api/status`, {
      headers: { Origin: 'https://untrusted.example' },
    });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.equal(
      (await fetch(`${base}/api/status?path=../../auth.json`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/status`, { method: 'POST' })).status,
      404,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
