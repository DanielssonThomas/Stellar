import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MAX_BYTES, POLL_MS, RefreshController, RetainedSnapshot, freshness } from "./snapshot-state.mjs";

const frame = (generated_at = 10, extras = {}) => JSON.stringify({
  schemaVersion: 1, generated_at, available: true, coverage: "Confirmed launch receipts only.", warnings: [],
  workers: [{ issue: 367, role: "peon-cloud", claim_session: "claim-367", runtime_session: null,
    incarnation: "inc-367", terminal: "t7", process: "exited", status: "blocked", exit_code: 0,
    tests: "unverified", review: "unverified", merge: "unverified", task: "private", ...extras }],
});

test("accepts producer Unix-seconds timestamp and keeps process distinct from verification", () => {
  const state = new RetainedSnapshot();
  const snapshot = state.accept(frame(10), 10000);
  assert.equal(snapshot.generated_at, 10);
  assert.equal(snapshot.workers[0].claim_session, "claim-367");
  assert.equal(snapshot.workers[0].runtime_session, null);
  assert.equal(snapshot.workers[0].exit_code, 0);
  assert.equal(snapshot.workers[0].review, "unverified");
  assert.equal("task" in snapshot.workers[0], false);
  assert.equal(freshness(1, 70000), "Snapshot stale · 69s old");
});

test("malformed, unavailable and oversized updates retain last-good identity", () => {
  const state = new RetainedSnapshot();
  state.accept(frame());
  const retained = state.snapshot;
  for (const raw of [null, "{bad", "x".repeat(MAX_BYTES + 1), JSON.stringify({ ...JSON.parse(frame()), available: false })]) {
    try { state.accept(raw); } catch (error) { state.fail(error); }
    assert.equal(state.snapshot, retained);
    assert.match(state.warning, /last-good/);
  }
});

test("refreshes do not overlap; disposal cancels scheduling after an in-flight read", async () => {
  const scheduled = [];
  let finish;
  let reads = 0;
  let notifications = 0;
  const controller = new RefreshController(() => {
    reads++;
    return new Promise((resolve) => { finish = resolve; });
  }, () => notifications++, (delay, callback) => {
    const task = { delay, callback, cancelled: false, cancel() { this.cancelled = true; } };
    scheduled.push(task);
    return task;
  });
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

test("successful refresh schedules the next one-shot only after completion", async () => {
  const scheduled = [];
  let notifications = 0;
  const controller = new RefreshController(async () => {}, () => notifications++, (delay, callback) => {
    const task = { delay, callback, cancel() {} };
    scheduled.push(task);
    return task;
  });
  controller.start();
  await scheduled[0].callback();
  assert.equal(notifications, 1);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, POLL_MS);
  controller.close();
});

test("a fresh mod instance recovers the exact retained identities from atomic source", () => {
  const directory = mkdtempSync(join(process.env.TMPDIR, "stellar-retained-"));
  try {
    const file = join(directory, "snapshot.json");
    writeFileSync(file, frame(), "utf8");
    const first = new RetainedSnapshot();
    first.accept(readFileSync(file, "utf8"));
    first.fail(new Error("temporary source outage"));
    assert.equal(first.snapshot.workers[0].issue, 367);
    const reopened = new RetainedSnapshot();
    reopened.accept(readFileSync(file, "utf8"));
    assert.equal(reopened.snapshot.workers[0].incarnation, "inc-367");
    assert.equal(reopened.snapshot.workers[0].claim_session, "claim-367");
    writeFileSync(file, frame(11, { status: "working" }), "utf8");
    const reconnected = new RetainedSnapshot();
    reconnected.accept(readFileSync(file, "utf8"));
    assert.equal(reconnected.snapshot.workers[0].claim_session, "claim-367");
    assert.equal(reconnected.snapshot.workers[0].status, "working");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
