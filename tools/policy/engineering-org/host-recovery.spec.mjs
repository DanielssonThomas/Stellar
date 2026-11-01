import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createHostFixture } from './host-fixtures.mjs';
import {
  createRepositoryAdmission,
  repositoryIssueDigest,
} from './host-context.mjs';
import { createEngineeringHost } from './host-engine.mjs';
import { openHostStore } from './host-store.mjs';
import { digest } from './planning-evidence.mjs';

const moduleUrl = (name) => new URL(`./${name}.mjs`, import.meta.url).href;
const runner = `
import { readFile, readdir } from 'node:fs/promises';
import { createRepositoryAdmission } from ${JSON.stringify(moduleUrl('host-context'))};
import { createEngineeringHost } from ${JSON.stringify(moduleUrl('host-engine'))};
import { inertRecipe } from ${JSON.stringify(moduleUrl('host-session'))};
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
let released;
const release = new Promise(resolve => { released = resolve; });
let paused = false;
const admission = createRepositoryAdmission({ ...config.options, hostReaders: {
  loadIssue: async () => {
    const names = await readdir(config.storeRoot).catch(error => { if(error.code === 'ENOENT') return []; throw error; });
    const atBoundary = config.boundary === 'reserved'
      ? names.some(name => name.endsWith('.dispatch.reservation'))
      : config.boundary === 'interphase' && names.some(name => name.endsWith('.implement.result')) && !names.some(name => name.endsWith('.verify.reservation'));
    if (!paused && atBoundary) { paused = true; process.send({type:'paused',boundary:config.boundary}); await release; }
    return config.issue;
  },
  resolveDevelopHead: async () => config.sourceRevision,
  now: () => '2026-11-01T12:00:00.000Z'
}});
const recipes = Object.fromEntries(await Promise.all(['dispatch','implement','verify','review','reconcile'].map(async phase => [phase, await inertRecipe(phase)])));
const host = await createEngineeringHost({ admission, recipes, storeRoot:config.storeRoot, poolRoot:config.poolRoot, timeoutMs:config.timeoutMs ?? 1000, faults:config.faults ?? {} });
process.on('message', async message => {
  if (message.type === 'release') { released(); return; }
  if (message.type !== 'start') return;
  try {
    const result = await host[config.operation](config.operation === 'prepare' ? config.request : config.grantId);
    process.send({type:'result',ok:true,status:result.status ?? result.value?.status,id:result.id ?? result.value?.grantId,digest:result.digest ?? null});
  } catch(error) { process.send({type:'result',ok:false,message:error.message,code:error.code ?? null}); }
});
process.on('disconnect', () => process.exit(0));
process.send({type:'ready'});
`;

async function until(read, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function fixture(t, number = 42) {
  const f = await createHostFixture();
  f.children = [];
  t.after(async () => {
    await Promise.all(f.children.map((child) => child.stop()));
    await rm(f.root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });
  if (number !== 42) {
    const branch = `issue/${number}-small-widget`;
    execFileSync('git', ['-C', f.worktree, 'branch', '-m', branch], {
      windowsHide: true,
    });
    f.issue.number = number;
    f.request.issueNumber = number;
    f.request.sessionId = `inert-claim-${number}`;
    Object.assign(f.claim, {
      issue: number,
      branch,
      sessionId: f.request.sessionId,
    });
    const claims = path.join(
      f.repositoryRoot,
      '.git',
      'stellar-agent',
      'claims',
    );
    await writeFile(
      path.join(claims, `${number}.json`),
      JSON.stringify(f.claim),
    );
    await rm(path.join(claims, '42.json'));
    const record = JSON.parse(
      await readFile(f.options.scopeRecordPath, 'utf8'),
    );
    Object.assign(record, {
      issueNumber: number,
      sessionId: f.request.sessionId,
      issueDigest: repositoryIssueDigest(f.issue),
    });
    await writeFile(f.options.scopeRecordPath, JSON.stringify(record));
    f.options.scopeRecordDigest = digest(record);
    f.hostOptions.admission = createRepositoryAdmission(f.options);
    f.host = await createEngineeringHost(f.hostOptions);
  }
  return f;
}

async function childHost(t, f, overrides = {}) {
  const configPath = path.join(f.root, 'recovery-runner.json');
  const runnerPath = path.join(f.root, 'recovery-runner.mjs');
  const scope = JSON.parse(await readFile(f.options.scopeRecordPath, 'utf8'));
  const options = {
    repositoryRoot: f.options.repositoryRoot,
    scopeRecordPath: f.options.scopeRecordPath,
    scopeRecordDigest: f.options.scopeRecordDigest,
  };
  await writeFile(
    configPath,
    JSON.stringify({
      options,
      issue: f.issue,
      sourceRevision: scope.sourceRevision,
      storeRoot: f.hostOptions.storeRoot,
      poolRoot: f.hostOptions.poolRoot,
      request: f.request,
      operation: 'prepare',
      ...overrides,
    }),
  );
  await writeFile(runnerPath, runner);
  const child = spawn(process.execPath, [runnerPath, configPath], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const events = [];
  let stderr = '';
  let closed = false;
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  child.on('message', (event) => events.push(event));
  const exited = new Promise((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  const stop = async () => {
    if (!closed) child.kill();
    await exited;
  };
  f.children.push({ stop });
  t.after(stop);
  const event = (type) =>
    until(() => {
      if (closed) throw new Error(`Host exited before ${type}: ${stderr}`);
      return events.find((value) => value.type === type);
    }, `host ${type}`);
  await event('ready');
  return {
    child,
    event,
    stop,
    start: () => child.send({ type: 'start' }),
    release: () => child.send({ type: 'release' }),
  };
}

async function stored(f, suffix) {
  return until(async () => {
    const names = await readdir(f.hostOptions.storeRoot);
    const name = names.find((item) => item.endsWith(suffix));
    if (!name) return null;
    try {
      return {
        name,
        ...(await (await openHostStore(f.hostOptions.storeRoot)).read(name)),
      };
    } catch (error) {
      if (error instanceof SyntaxError || error.code === 'ENOENT') return null;
      throw error;
    }
  }, suffix);
}

async function shared(t) {
  const first = await fixture(t);
  const second = await fixture(t, 43);
  second.hostOptions.poolRoot = first.hostOptions.poolRoot;
  second.host = await createEngineeringHost(second.hostOptions);
  return [first, second];
}

async function noAttempt(f, id) {
  const names = await readdir(f.hostOptions.storeRoot);
  for (const suffix of [
    'attempt.reservation',
    'handoff.json',
    'implement.reservation',
    'implement.launch',
  ]) {
    assert.equal(
      names.includes(`${id}.${suffix}`),
      false,
      `Queued work created ${suffix}`,
    );
  }
}

test(
  'two actual hosts serialize dispatch and the queued assignment retries without a new key',
  { timeout: 60_000 },
  async (t) => {
    const fixtures = await shared(t);
    const hosts = await Promise.all(
      fixtures.map((f) =>
        childHost(t, f, { boundary: 'reserved', faults: { dispatch: 'hang' } }),
      ),
    );
    hosts.forEach((host) => host.start());
    const winner = await Promise.race(
      hosts.map((host, index) => host.event('paused').then(() => index)),
    );
    const loser = 1 - winner;
    const queued = await hosts[loser].event('result');
    assert.equal(queued.status, 'queued');
    const winnerNames = await readdir(fixtures[winner].hostOptions.storeRoot);
    const loserNames = await readdir(fixtures[loser].hostOptions.storeRoot);
    assert.equal(
      winnerNames.filter((name) => name.endsWith('.dispatch.reservation'))
        .length,
      1,
    );
    assert.equal(
      loserNames.some((name) => name.includes('.dispatch.')),
      false,
    );
    hosts[winner].release();
    const failed = await hosts[winner].event('result');
    assert.equal(failed.ok, false);
    assert.match(failed.message, /did not authorize/);
    const session = await stored(fixtures[winner], '.dispatch.result');
    assert.equal(session.value.receipt.failure, 'timeout');
    assert.equal(session.value.receipt.terminated, true);
    assert.equal((await fixtures[winner].host.recover()).status, 'idle');
    const retried = await fixtures[loser].host.prepare(fixtures[loser].request);
    assert.equal(retried.id, queued.id);
    assert.equal(retried.status, 'dispatched');
    await assert.rejects(
      fixtures[loser].host.prepare({
        ...fixtures[loser].request,
        key: 'different-key',
      }),
      /already consumed/,
    );
  },
);

test(
  'prepared hosts keep the attempt lease across implement and verify without consuming queued work',
  { timeout: 90_000 },
  async (t) => {
    const fixtures = await shared(t);
    const grants = [];
    for (const f of fixtures) grants.push(await f.host.prepare(f.request));
    const hosts = await Promise.all(
      fixtures.map((f, index) =>
        childHost(t, f, {
          operation: 'execute',
          grantId: grants[index].id,
          boundary: 'interphase',
        }),
      ),
    );
    hosts.forEach((host) => host.start());
    const winner = await Promise.race(
      hosts.map((host, index) => host.event('paused').then(() => index)),
    );
    const loser = 1 - winner;
    assert.equal((await hosts[loser].event('result')).status, 'queued');
    await noAttempt(fixtures[loser], grants[loser].id);
    const pool = await openHostStore(fixtures[winner].hostOptions.poolRoot);
    const slot = await pool.read('active');
    assert.equal(slot.value.phase, 'attempt');
    const implement = await stored(fixtures[winner], '.implement.result');
    assert.equal(implement.value.receipt.terminated, true);
    assert.equal(
      (await readdir(fixtures[winner].hostOptions.storeRoot)).some((name) =>
        name.endsWith('.verify.reservation'),
      ),
      false,
    );
    assert.equal(
      (await fixtures[loser].host.execute(grants[loser].id)).value.status,
      'queued',
    );
    await noAttempt(fixtures[loser], grants[loser].id);
    assert.equal((await pool.read('active')).digest, slot.digest);
    hosts[winner].release();
    assert.equal((await hosts[winner].event('result')).ok, true);
    assert.equal(await pool.exists('active'), false);
    const cleanup = await stored(fixtures[winner], '.cleanup');
    assert.equal(cleanup.value.slotDigest, slot.digest);
    assert.deepEqual(
      cleanup.value.sessions.map((session) => session.phase),
      ['implement', 'verify'],
    );
    const store = await openHostStore(fixtures[winner].hostOptions.storeRoot);
    for (const session of cleanup.value.sessions) {
      assert.equal(
        (
          await store.read(
            `${grants[winner].id}.${session.phase}.result`,
            session.resultDigest,
          )
        ).value.receipt.nonce,
        session.nonce,
      );
    }
    const retried = await fixtures[loser].host.execute(grants[loser].id);
    assert.ok(retried.value.candidate);
    assert.equal((await fixtures[loser].host.recover()).status, 'idle');
  },
);

for (const boundary of ['reserved', 'launched']) {
  test(
    `a killed host after ${boundary} dispatch retains its consumed authorization and uncertain slot`,
    { timeout: 60_000 },
    async (t) => {
      const f = await fixture(t);
      const child = await childHost(t, f, {
        boundary: boundary === 'reserved' ? 'reserved' : null,
        faults: { dispatch: 'hang' },
        timeoutMs: 10_000,
      });
      child.start();
      if (boundary === 'reserved') await child.event('paused');
      else await stored(f, '.dispatch.launch');
      const pool = await openHostStore(f.hostOptions.poolRoot);
      const before = await pool.read('active');
      assert.equal(before.value.ownerPid, child.child.pid);
      await child.stop();
      const recovery = await f.host.recover();
      assert.equal(recovery.status, 'quarantined');
      assert.equal(recovery.replayAllowed, false);
      assert.equal((await pool.read('active')).digest, before.digest);
      const names = await readdir(f.hostOptions.storeRoot);
      assert.equal(
        names.some((name) => name.endsWith('.dispatch.result')),
        false,
      );
      assert.equal(
        names.some((name) => name.endsWith('.dispatch.launch')),
        boundary === 'launched',
      );
      await assert.rejects(
        f.host.prepare(f.request),
        /already consumed.*quarantined/,
      );
      await assert.rejects(
        f.host.prepare({ ...f.request, key: 'retry-under-new-key' }),
        /already consumed/,
      );
      assert.equal((await pool.read('active')).digest, before.digest);
    },
  );
}

test(
  'recovery releases a recorded stopped result only after the real owner and child have exited',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const child = await childHost(t, f, {
      faults: { dispatch: 'hang' },
      timeoutMs: 1000,
    });
    child.start();
    const launch = await stored(f, '.dispatch.launch');
    const guard = path.join(f.hostOptions.poolRoot, 'active.guard');
    await writeFile(guard, 'hold release for recovery test', { flag: 'wx' });
    const session = await stored(f, '.dispatch.result');
    assert.equal(session.value.receipt.pid, launch.value.pid);
    assert.equal(session.value.receipt.terminated, true);
    assert.equal((await child.event('result')).code, 'EEXIST');
    await rm(guard);
    assert.equal((await f.host.recover()).status, 'quarantined');
    await child.stop();
    const recovered = await f.host.recover();
    assert.equal(recovered.status, 'stopped-result-retained');
    assert.equal(recovered.replayAllowed, false);
    assert.equal((await f.host.recover()).status, 'idle');
    const store = await openHostStore(f.hostOptions.storeRoot);
    assert.equal(
      (await store.read(session.name, session.digest)).digest,
      session.digest,
    );
  },
);
