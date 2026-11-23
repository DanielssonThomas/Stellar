import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  MAX_BYTES,
  POLL_MS,
  RefreshController,
  RetainedSnapshot,
  freshness,
  requestedIssue,
  utf8ByteLength,
} from './snapshot-state.mjs';

const frame = (generated_at = 10, extras = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    generated_at,
    available: true,
    coverage: 'Confirmed launch receipts only.',
    warnings: [],
    workers: [
      {
        issue: 367,
        role: 'peon-cloud',
        claim_session: 'claim-367',
        runtime_session: null,
        incarnation: 'inc-367',
        terminal: 't7',
        process: 'exited',
        status: 'blocked',
        exit_code: 0,
        source: 'attempts/367/terminal.json',
        tests: 'unverified',
        review: 'unverified',
        merge: 'unverified',
        task: 'private',
        ...extras,
      },
    ],
  });

test('loads only the exact bounded retained issue request once', () => {
  const snapshot = JSON.parse(frame(10, { issue: 352 }));
  const request = {
    schemaVersion: 1,
    id: 'a'.repeat(32),
    issue: 352,
    createdAt: 10,
    expiresAt: 18,
    phase: 'ready',
    snapshot,
  };
  const next = requestedIssue(JSON.stringify(request), 11000);
  assert.equal(next.issue, 352);
  assert.deepEqual(
    next.snapshot.workers.map((worker) => worker.issue),
    [352],
  );
  assert.equal('task' in next.snapshot.workers[0], false);
  const ack = next.confirm('overlay-123', 11);
  assert.deepEqual(JSON.parse(ack), {
    ...request,
    overlay: 'overlay-123',
    loadedAt: 11,
  });
  assert.equal(requestedIssue(ack, 11000), null);
  assert.equal(requestedIssue(JSON.stringify(request), 18000), null);
  const opening = requestedIssue(
    JSON.stringify({ ...request, phase: 'opening' }),
    11000,
  );
  assert.equal(opening.phase, 'opening');
  assert.equal(opening.snapshot, null);
  assert.equal(
    requestedIssue(JSON.stringify({ ...request, issue: 367 }), 11000),
    null,
  );
  assert.equal(
    requestedIssue(
      JSON.stringify({ ...request, snapshot: { ...snapshot, workers: [] } }),
      11000,
    ),
    null,
  );
});

test('accepts producer Unix-seconds timestamp and keeps process distinct from verification', () => {
  const state = new RetainedSnapshot();
  const snapshot = state.accept(frame(10), 10000);
  assert.equal(snapshot.generated_at, 10);
  assert.equal(snapshot.workers[0].claim_session, 'claim-367');
  assert.equal(snapshot.workers[0].runtime_session, null);
  assert.equal(snapshot.workers[0].exit_code, 0);
  assert.equal(snapshot.workers[0].review, 'unverified');
  assert.equal('task' in snapshot.workers[0], false);
  assert.equal(freshness(1, 70000), 'Snapshot stale · 69s old');
});

test('malformed, unavailable and oversized updates retain last-good identity', () => {
  const state = new RetainedSnapshot();
  state.accept(frame());
  const retained = state.snapshot;
  for (const raw of [
    null,
    '{bad',
    'x'.repeat(MAX_BYTES + 1),
    JSON.stringify({ ...JSON.parse(frame()), available: false }),
  ]) {
    try {
      state.accept(raw);
    } catch (error) {
      state.fail(error);
    }
    assert.equal(state.snapshot, retained);
    assert.match(state.warning, /last-good/);
  }
});

test('malformed worker identity and nested or unknown private fields never replace last-good state', () => {
  const state = new RetainedSnapshot();
  state.accept(frame());
  const retained = state.snapshot;
  const base = JSON.parse(frame());
  const invalid = [
    { ...base, workers: [null] },
    { ...base, workers: [{ ...base.workers[0], claim_session: undefined }] },
    {
      ...base,
      workers: [{ ...base.workers[0], summary: { reasoning: 'private' } }],
    },
  ];
  for (const value of invalid) {
    try {
      state.accept(JSON.stringify(value));
    } catch (error) {
      state.fail(error);
    }
    assert.equal(state.snapshot, retained);
    assert.match(state.warning, /last-good/);
  }
  const accepted = state.accept(
    JSON.stringify({
      ...base,
      reasoning: 'private',
      extra: { task: 'private' },
    }),
  );
  assert.deepEqual(Object.keys(accepted).sort(), [
    'available',
    'coverage',
    'generated_at',
    'schemaVersion',
    'warnings',
    'workers',
  ]);
  assert.equal('reasoning' in accepted, false);
  assert.equal('extra' in accepted, false);
});

test('UTF-8 byte bounds work without TextEncoder and preserve prior snapshots', () => {
  const sample = 'ASCII|é|水|😀|\ud800';
  assert.equal(utf8ByteLength(sample), Buffer.byteLength(sample, 'utf8'));
  const original = globalThis.TextEncoder;
  globalThis.TextEncoder = undefined;
  try {
    const state = new RetainedSnapshot();
    state.accept(frame());
    const lastGood = state.snapshot;
    const oversized = JSON.stringify({
      ...JSON.parse(frame()),
      coverage: 'é'.repeat(33000),
    });
    assert.ok(oversized.length < MAX_BYTES);
    assert.ok(Buffer.byteLength(oversized, 'utf8') > MAX_BYTES);
    assert.throws(() => state.accept(oversized), /64 KiB/);
    state.fail(new Error('Snapshot exceeds 64 KiB.'));
    assert.equal(state.snapshot, lastGood);
    assert.match(state.warning, /last-good/);
    assert.equal(state.accept(frame()).workers[0].claim_session, 'claim-367');
  } finally {
    globalThis.TextEncoder = original;
  }
});

test('native overview root keeps a stable id and vertical scrolling enabled', () => {
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(source, /\.id\((['"])stellar-retained-overview-root\1\)/);
  assert.match(source, /\.overflow_y_scrollbar\(\)/);
  assert.doesNotMatch(source, /TextEncoder/);
});

test('uses the native host overlay to select and acknowledge a rendered issue', async (t) => {
  t.mock.method(Date, 'now', () => 11000);
  const requestPath = '/fixture/stellar-retained-overview-request.json';
  const request = {
    schemaVersion: 1,
    id: 'a'.repeat(32),
    issue: 352,
    createdAt: 10,
    expiresAt: 18,
    phase: 'ready',
    snapshot: JSON.parse(frame(10, { issue: 352 })),
  };
  const moduleURL = (source) =>
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const ui = moduleURL(`
    export class View {}
    export function div() {
      const children = [];
      const element = new Proxy({children}, {
        get: (node, key) => key === 'child'
          ? (child) => { children.push(child); return element; }
          : Reflect.has(node, key) ? node[key] : () => element,
      });
      return element;
    }
  `);
  const bridge = moduleURL(`
    export const files = new Map();
    export const context = {};
    export const appHome = () => '/fixture';
    export const props = () => context;
    export const closeOverlay = () => {};
    export const readTextFile = async (path) => files.get(path) ?? null;
    export const writeTextFile = async (path, data, expected) => {
      if (files.get(path) !== expected) throw Error('Superseded request');
      files.set(path, data);
    };
  `);
  const { files, context } = await import(bridge);
  files.set(requestPath, JSON.stringify(request));
  files.set('/fixture/stellar-retained-overview.json', frame(10));

  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
    .replace("'gpui-kit'", JSON.stringify(ui))
    .replace("'herdr'", JSON.stringify(bridge))
    .replace(
      "'./snapshot-state.mjs'",
      JSON.stringify(new URL('./snapshot-state.mjs', import.meta.url).href),
    );
  const { default: Overview } = await import(moduleURL(source));
  const text = (node) =>
    typeof node === 'string' ? node : node.children.map(text).join(' ');

  async function open(initProps) {
    const view = new Overview();
    const callbacks = [];
    const cx = {
      notify() {},
      timer: {
        after(_delay, callback) {
          callbacks.push(callback);
          return { cancel() {} };
        },
      },
    };
    view.init(initProps, cx);
    await callbacks.shift()(cx);
    return {
      view,
      render: () => text(view.render()),
      step: () => callbacks.shift()(cx),
    };
  }

  context.overlay = 'mod-stellar-retained-overview';
  const scoped = await open({});
  assert.deepEqual(JSON.parse(files.get(requestPath)), request);
  const rendered = scoped.render();
  assert.match(rendered, /Issue #352 · retained attempts/);
  assert.doesNotMatch(rendered, /Issue #367/);
  await scoped.step();
  assert.deepEqual(JSON.parse(files.get(requestPath)), {
    ...request,
    overlay: context.overlay,
    loadedAt: 11,
  });
  scoped.view.close();
  assert.deepEqual(JSON.parse(files.get(requestPath)), { closed: true });

  delete context.overlay;
  files.set(requestPath, JSON.stringify(request));
  const combined = await open({ overlay: 'untrusted-init-prop' });
  assert.match(combined.render(), /Issue #367/);
  assert.doesNotMatch(combined.render(), /Issue #352/);
  assert.deepEqual(JSON.parse(files.get(requestPath)), request);
  combined.view.close();
});

test('refreshes do not overlap; disposal cancels scheduling after an in-flight read', async () => {
  const scheduled = [];
  let finish;
  let reads = 0;
  let notifications = 0;
  const controller = new RefreshController(
    () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => notifications++,
    (delay, callback) => {
      const task = {
        delay,
        callback,
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      scheduled.push(task);
      return task;
    },
  );
  controller.start();
  assert.equal(scheduled[0].delay, 0);
  const pending = scheduled[0].callback();
  await Promise.resolve();
  await controller.tick();
  assert.equal(reads, 1);
  controller.close();
  finish();
  await pending;
  assert.equal(notifications, 0);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].cancelled, true);
  assert.equal(POLL_MS, 5000);
});

test('successful refresh schedules the next one-shot only after completion', async () => {
  const scheduled = [];
  let notifications = 0;
  const controller = new RefreshController(
    async () => {},
    () => notifications++,
    (delay, callback) => {
      const task = { delay, callback, cancel() {} };
      scheduled.push(task);
      return task;
    },
  );
  controller.start();
  await scheduled[0].callback();
  assert.equal(notifications, 1);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, POLL_MS);
  controller.close();
});

test('a fresh mod instance recovers the exact retained identities from atomic source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stellar-retained-'));
  try {
    const file = join(directory, 'snapshot.json');
    writeFileSync(file, frame(), 'utf8');
    const first = new RetainedSnapshot();
    first.accept(readFileSync(file, 'utf8'));
    first.fail(new Error('temporary source outage'));
    assert.equal(first.snapshot.workers[0].issue, 367);
    const reopened = new RetainedSnapshot();
    reopened.accept(readFileSync(file, 'utf8'));
    assert.equal(reopened.snapshot.workers[0].incarnation, 'inc-367');
    assert.equal(reopened.snapshot.workers[0].claim_session, 'claim-367');
    writeFileSync(file, frame(11, { status: 'working' }), 'utf8');
    const reconnected = new RetainedSnapshot();
    reconnected.accept(readFileSync(file, 'utf8'));
    assert.equal(reconnected.snapshot.workers[0].claim_session, 'claim-367');
    assert.equal(reconnected.snapshot.workers[0].status, 'working');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
