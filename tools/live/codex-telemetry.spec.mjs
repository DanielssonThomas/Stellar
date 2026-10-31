import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectCodexAgents,
  normalizeCodexThreads,
  projectForCwd,
} from './codex-telemetry.mjs';

const now = 1_800_000_000_000;
const row = {
  id: 'private-thread',
  cwd: 'D:\\ai-repositories\\stellar-design',
  turn_id: 'private-turn',
  status: 'inProgress',
  started_at: now / 1000 - 60,
  completed_at: null,
  items: [
    {
      item_id: 'one',
      item_type: 'commandExecution',
      created_at_ms: now - 2_000,
    },
    { item_id: 'two', item_type: 'agentMessage', created_at_ms: now - 1_000 },
  ],
};

test('project association uses only known repository folders', () => {
  assert.equal(
    projectForCwd('D:\\ai-repositories\\stellar-issue-170'),
    'stellar',
  );
  assert.equal(
    projectForCwd('D:\\ai-repositories\\stellar-design'),
    'stellar-design',
  );
  assert.equal(projectForCwd('D:\\other\\private'), null);
});

test('fresh in-progress Codex turn is visible with allowlisted metadata only', () => {
  const [agent] = normalizeCodexThreads([row], now);
  assert.equal(agent.state, 'running');
  assert.equal(agent.project, 'stellar-design');
  assert.equal(agent.activity, 'Posted an update');
  assert.equal(agent.source.kind, 'codex-local-turn-history');
  assert.equal(JSON.stringify(agent).includes('private'), false);
  assert.equal(agent.events.length, 2);
});

test('stale unfinished turns cannot animate as running', () => {
  const [agent] = normalizeCodexThreads(
    [{ ...row, items: [{ ...row.items[0], created_at_ms: now - 6 * 60_000 }] }],
    now,
  );
  assert.equal(agent.state, 'unknown');
  assert.equal(agent.activity, null);
});

test('recorded terminal state and source failure are distinct', () => {
  const [completed] = normalizeCodexThreads(
    [{ ...row, status: 'completed', completed_at: now / 1000 - 1 }],
    now,
  );
  assert.equal(completed.state, 'completed');
  assert.equal(completed.events.at(-1).kind, 'completion');
  const [disconnected] = collectCodexAgents({
    now,
    readHistory: () => {
      throw new Error('missing');
    },
  });
  assert.equal(disconnected.state, 'disconnected');
});
