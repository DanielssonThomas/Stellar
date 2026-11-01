import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertHostSessionReceipt,
  inertRecipe,
  isHostSessionNotStarted,
  liveRecipe,
  registerHostRecipe,
  runHostSession,
} from './host-session.mjs';
import { digest } from './planning-evidence.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'stellar-host-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function customRecipe(root, source, overrides = {}) {
  const entryPoint = join(root, `${randomUUID()}.mjs`);
  await writeFile(
    entryPoint,
    `process.once('disconnect', () => process.exit(0));\n${source}`,
  );
  return registerHostRecipe({
    phase: 'review',
    role: 'foreman',
    entryPoint,
    expectedDigest: createHash('sha256')
      .update(await readFile(entryPoint))
      .digest('hex'),
    mode: 'inert',
    ...overrides,
  });
}

const echo =
  "process.once('message', ({nonce,packet}) => { process.send({nonce,result:packet}); setImmediate(() => process.disconnect()); });";

test('synchronous host guard rejects after asynchronous preparation without starting a child', async (t) => {
  const root = await workspace(t);
  const recipe = await inertRecipe('dispatch');
  const nonce = randomUUID();
  let expired = false;
  let spawned = false;
  const execution = runHostSession({
    recipe,
    packet: {},
    nonce,
    workspace: join(root, 'session'),
    assertBeforeSpawn: () => {
      assert.equal(expired, true);
      throw new Error('expired');
    },
    onSpawn: () => {
      spawned = true;
    },
  });
  expired = true;
  await assert.rejects(execution, (error) => {
    assert.equal(isHostSessionNotStarted(error), true);
    assert.equal(isHostSessionNotStarted({ ...error }), false);
    assert.equal(
      isHostSessionNotStarted(error, { nonce: randomUUID() }),
      false,
    );
    assert.equal(isHostSessionNotStarted(error, { phase: 'review' }), false);
    assert.equal(
      isHostSessionNotStarted(error, { packetDigest: digest({ other: true }) }),
      false,
    );
    assert.equal(
      isHostSessionNotStarted(error, {
        phase: 'dispatch',
        nonce,
        packetDigest: digest({}),
      }),
      true,
    );
    assert.equal(error.cause.message, 'expired');
    return true;
  });
  assert.equal(spawned, false);
  await assert.rejects(
    runHostSession({
      recipe,
      packet: {},
      workspace: root,
      assertBeforeSpawn: async () => undefined,
    }),
    (error) =>
      isHostSessionNotStarted(error) &&
      /synchronously/.test(error.cause.message),
  );
});

test('attributes a real child to its host recipe, ignoring role claims in its output', async (t) => {
  const root = await workspace(t);
  const recipe = await customRecipe(root, echo);
  const packet = { role: 'architect', caller: 'architect', issueNumber: 42 };
  let spawned;
  const receipt = await runHostSession({
    recipe,
    packet,
    workspace: root,
    onSpawn: (value) => {
      spawned = value;
    },
  });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.terminated, true);
  assert.equal(receipt.role, 'foreman');
  assert.equal(receipt.result.role, 'architect');
  assert.equal(receipt.pid, spawned.pid);
  assert.equal(receipt.packetDigest, digest(packet));
  assert.equal(
    assertHostSessionReceipt(receipt, {
      phase: 'review',
      nonce: spawned.nonce,
      packetDigest: digest(packet),
    }),
    receipt,
  );
  assert.deepEqual(receipt.usage, { requests: 0, modelTokens: 0 });
});

test('rejects cloned recipe handles and receipt objects and mismatched channel bindings', async (t) => {
  const root = await workspace(t);
  const recipe = await inertRecipe('dispatch');
  const options = { recipe, packet: { issueNumber: 42 }, workspace: root };
  await assert.rejects(
    runHostSession({ ...options, recipe: { ...recipe } }),
    /recipe handle/,
  );
  const receipt = await runHostSession(options);
  assert.equal(receipt.status, 'completed');
  for (const forged of [
    { ...receipt },
    JSON.parse(JSON.stringify(receipt)),
    { authenticated: true },
  ]) {
    assert.throws(() => assertHostSessionReceipt(forged), /Untrusted/);
  }
  for (const binding of [
    { phase: 'implement' },
    { nonce: randomUUID() },
    { packetDigest: 'a'.repeat(64) },
  ]) {
    assert.throws(
      () => assertHostSessionReceipt(receipt, binding),
      /mismatched/,
    );
  }
});

test('detaches the packet before a spawn callback can mutate caller-owned input', async (t) => {
  const root = await workspace(t);
  const recipe = await customRecipe(root, echo);
  const packet = { nested: { value: 2 } };
  const expected = digest(packet);
  const receipt = await runHostSession({
    recipe,
    packet,
    workspace: root,
    onSpawn: () => {
      packet.nested.value = 99;
    },
  });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.result.nested.value, 2);
  assert.equal(receipt.packetDigest, expected);
  assert.equal(digest(receipt.result), expected);
});

test('keeps authenticated receipt results and usage immutable', async (t) => {
  const root = await workspace(t);
  const recipe = await customRecipe(root, echo);
  const receipt = await runHostSession({
    recipe,
    packet: { checks: [{ status: 'failed' }] },
    workspace: root,
  });
  assert.throws(() => {
    receipt.result.checks[0].status = 'passed';
  }, TypeError);
  assert.throws(() => {
    receipt.usage.modelTokens = 100;
  }, TypeError);
  assert.equal(
    assertHostSessionReceipt(receipt).result.checks[0].status,
    'failed',
  );
});

test('supplies an allowlisted child environment without parent credential canaries', async (t) => {
  const root = await workspace(t);
  const keys = ['STELLAR_TEST_SECRET_CANARY', 'GH_TOKEN', 'OPENAI_API_KEY'];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = 'test-only-do-not-forward';
  t.after(() =>
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }),
  );
  const recipe = await customRecipe(
    root,
    "process.once('message', ({nonce}) => { process.send({nonce,result:{present:['STELLAR_TEST_SECRET_CANARY','GH_TOKEN','OPENAI_API_KEY'].filter(key => Object.hasOwn(process.env,key))}}); setImmediate(() => process.disconnect()); });",
  );
  const receipt = await runHostSession({ recipe, packet: {}, workspace: root });
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.result.present, []);
});

for (const [fault, failure] of [
  ['foreign-channel', 'invalid-channel-output'],
  ['oversize', 'output-limit'],
  ['provider-failure', 'provider-quota'],
  ['hang', 'timeout'],
]) {
  test(`fails closed for ${fault} and confirms child termination`, async (t) => {
    const root = await workspace(t);
    const receipt = await runHostSession({
      recipe: await inertRecipe('dispatch'),
      packet: { issueNumber: 42 },
      workspace: root,
      fault,
      timeoutMs: fault === 'hang' ? 100 : 2000,
    });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.failure, failure);
    assert.equal(receipt.terminated, true);
    assert.equal(assertHostSessionReceipt(receipt).failure, failure);
  });
}

test('fails after an unsuccessful spawn journal and on host cancellation', async (t) => {
  const root = await workspace(t);
  const options = {
    recipe: await inertRecipe('dispatch'),
    packet: { issueNumber: 42 },
    workspace: root,
  };
  const journalFailure = await runHostSession({
    ...options,
    onSpawn: () => {
      throw new Error('journal unavailable');
    },
  });
  assert.equal(journalFailure.failure, 'launch-record-failed');
  assert.equal(journalFailure.terminated, true);
  const controller = new AbortController();
  const cancelled = await runHostSession({
    ...options,
    signal: controller.signal,
    onSpawn: () => controller.abort(),
  });
  assert.equal(cancelled.failure, 'cancelled');
  assert.equal(cancelled.terminated, true);
});

test('rejects changed recipe bytes, live execution, bad bounds and sparse packets', async (t) => {
  const root = await workspace(t);
  const recipe = await customRecipe(root, echo);
  const options = { recipe, packet: {}, workspace: root };
  await writeFile(recipe.entryPoint, `${echo}\n// changed`);
  await assert.rejects(runHostSession(options), /recipe changed/);
  assert.throws(liveRecipe, /not qualified/);
  const valid = { ...options, recipe: await inertRecipe('dispatch') };
  await assert.rejects(
    runHostSession({ ...valid, timeoutMs: 10001 }),
    /limits/,
  );
  await assert.rejects(
    runHostSession({ ...valid, packet: { text: '界'.repeat(11000) } }),
    /byte bound/,
  );
  await assert.rejects(
    runHostSession({ ...valid, packet: new Array(1) }),
    /dense JSON/,
  );
});

test('rejects coercible recipe phases and session identities', async (t) => {
  const root = await workspace(t);
  await assert.rejects(
    customRecipe(root, echo, { phase: ['review'] }),
    /inert recipes/,
  );
  const recipe = await inertRecipe('dispatch');
  await assert.rejects(
    runHostSession({
      recipe,
      packet: {},
      workspace: root,
      nonce: [randomUUID()],
    }),
    /session identity/,
  );
});

test('rejects a second message on a child channel', async (t) => {
  const root = await workspace(t);
  const recipe = await customRecipe(
    root,
    "process.once('message', ({nonce}) => { process.send({nonce,result:{one:true}}); process.send({nonce,result:{two:true}}); setImmediate(() => process.disconnect()); });",
  );
  const receipt = await runHostSession({ recipe, packet: {}, workspace: root });
  assert.equal(receipt.failure, 'invalid-channel-output');
  assert.equal(receipt.terminated, true);
});
