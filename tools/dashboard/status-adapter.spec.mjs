import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  readHermesStatus,
  readGithubStatus,
  readCharacterStatus,
} from './status-adapter.mjs';
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

test('paginates open issues before computing complete counts', async () => {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    const page = new URL(url).searchParams.get('page');
    const batch = url.includes('/pulls?')
      ? []
      : url.includes('state=closed')
        ? []
        : page === '1'
          ? Array.from({ length: 100 }, (_, index) => ({
              number: index + 1,
              title: 'Issue',
              labels: [],
            }))
          : [
              {
                number: 101,
                title: 'Later blocked issue',
                labels: [{ name: 'status:blocked' }],
              },
            ];
    return { ok: true, json: async () => batch };
  };
  const result = await readGithubStatus(fetcher);
  assert.equal(result.issues.length, 101);
  assert.equal(result.issues[100].blocked, true);
  assert.equal(result.complete, true);
  assert.ok(
    seen.some((url) => url.includes('/issues?state=open&per_page=100&page=2')),
  );
});

test('reads a fixed character production record without returning local paths or notes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stellar-design-status-'));
  const base = path.join(root, 'characters', 'stellar-assistant');
  await mkdir(base, { recursive: true });
  await writeFile(
    path.join(base, 'phase-state.json'),
    JSON.stringify({
      character_id: 'stellar-assistant',
      phase: 'phase_1_vroid_creation',
      handoff_status: 'blocked_pending_user_visual_approval',
      phase2_launch_allowed: false,
    }),
  );
  await writeFile(
    path.join(base, 'design-contract.yaml'),
    JSON.stringify({
      character_id: 'stellar-assistant',
      approval: { status: 'approved' },
      references: ['secret-local-reference'],
    }),
  );
  await writeFile(
    path.join(base, 'phase1-progress.json'),
    JSON.stringify({
      character_id: 'stellar-assistant',
      status: 'phase1_fidelity_refinement',
      blocker: 'Visual mismatch',
      source: null,
      export: null,
      designer_sessions: [{ id: 'private-session-id' }],
      requirements: [
        {
          id: 'FACE-001',
          status: 'visually_mismatched',
          note: 'PRIVATE_NOTES',
        },
        { id: 'BODY-002', status: 'achieved' },
      ],
    }),
  );
  await writeFile(
    path.join(base, 'designer-session-audit.json'),
    JSON.stringify({
      character_id: 'stellar-assistant',
      status: 'verified_disposable_edit_unpromoted',
      private_trace: 'PRIVATE_TRACE',
    }),
  );
  try {
    const result = await readCharacterStatus(root);
    assert.equal(result.state, 'observed');
    assert.equal(result.vroid.achieved, 1);
    assert.equal(result.outstanding[0].id, 'FACE-001');
    assert.equal(result.blender.launchAllowed, false);
    assert.equal(result.designerSessionCount, 1);
    assert.equal(
      result.technicalValidation,
      'verified disposable edit unpromoted',
    );
    assert.ok(!JSON.stringify(result).includes('PRIVATE_NOTES'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_TRACE'));
    assert.ok(!JSON.stringify(result).includes('private-session-id'));
    assert.ok(!JSON.stringify(result).includes('secret-local-reference'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      (await fetch(`${base}/api/character-image/latest?path=../../auth.json`))
        .status,
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
