import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { performDirectPatch } from './avatar-patch-client.mjs';
import {
  applyAndVerify,
  clientContainerArgs,
  confirmBenchmarkCleanup,
  disposeCheckout,
  installInterruptGuard,
  makeDisposableCheckout,
  meterContainerArgs,
  reserveOneUseRun,
  runBoundedPodman,
  verifyUi,
  verifierContainerArgs,
} from './avatar-direct-patch.mjs';
import {
  avatarSource,
  avatarTest,
  validateAvatarPatch,
  validateAvatarResult,
  validateUsage,
} from './avatar-patch-core.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('rejects escaped, renamed, binary, duplicate, and fenced patches', () => {
  const good = `diff --git a/${avatarSource} b/${avatarSource}\n--- a/${avatarSource}\n+++ b/${avatarSource}\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/${avatarTest} b/${avatarTest}\nnew file mode 100644\n--- /dev/null\n+++ b/${avatarTest}\n@@ -0,0 +1 @@\n+test\n`;
  assert.deepEqual(validateAvatarPatch(good), [avatarSource, avatarTest]);
  for (const bad of [
    good.replace(avatarSource, '../outside'),
    good.replace('new file mode 100644', 'new file mode 120000'),
    good.replace('new file mode 100644', 'rename from elsewhere'),
    good.replace('+test', 'GIT binary patch'),
    `${good}${good.split('diff --git a/')[1]}`,
    `\`\`\`diff\n${good}\`\`\``,
  ])
    assert.throws(() => validateAvatarPatch(bad));
});

test('requires concrete avatar implementation and focused assertions', () => {
  const source = `export type SkeletonShape = 'text' | 'control' | 'avatar';\n'h-10 w-10 rounded-full'; aria-hidden="true";`;
  const spec = `SkeletonAtom; setInput('shape', 'avatar'); expect(classes).toContain('h-10 w-10 rounded-full'); aria-hidden;`;
  assert.doesNotThrow(() => validateAvatarResult(source, spec));
  assert.throws(
    () => validateAvatarResult(source, 'baseline tests only'),
    /coverage/,
  );
  assert.throws(() => validateAvatarResult('unchanged', spec), /behavior/);
});

test('requires complete, bounded trusted usage', () => {
  assert.deepEqual(
    validateUsage({
      prompt_tokens: 1800,
      completion_tokens: 1200,
      total_tokens: 3000,
    }),
    { prompt: 1800, output: 1200, total: 3000 },
  );
  assert.throws(
    () =>
      validateUsage({
        prompt_tokens: 1801,
        completion_tokens: 1,
        total_tokens: 1802,
      }),
    /limit/,
  );
  assert.throws(
    () =>
      validateUsage({
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 3,
      }),
    /inconsistent/,
  );
  assert.throws(() => validateUsage({}), /missing/);
});

test('fake model receives exactly one tool-free completion after prompt preflight', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const value = url.endsWith('/apply-template')
      ? { prompt: 'formatted' }
      : url.endsWith('/tokenize')
        ? { tokens: [1, 2, 3] }
        : {
            choices: [{ message: { content: 'diff --git ...' } }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          };
    return { ok: true, json: async () => value };
  };
  const response = await performDirectPatch('avatar objective', { fetchImpl });
  assert.equal(response.preflightPromptTokens, 3);
  assert.equal(
    requests.filter((entry) => entry.url.endsWith('/v1/chat/completions'))
      .length,
    1,
  );
  assert.equal(requests[2].body.max_tokens, 1_200);
  assert.equal(requests[2].body.tools, undefined);
  assert.deepEqual(requests[2].body.messages, [
    { role: 'user', content: 'avatar objective' },
  ]);
});

test('oversize prompt and tool-return shape stop without forwarding a second completion', async () => {
  const calls = [];
  const overLimit = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () =>
        url.endsWith('/apply-template')
          ? { prompt: 'formatted' }
          : { tokens: Array(1_801).fill(1) },
    };
  };
  await assert.rejects(
    performDirectPatch('task', { fetchImpl: overLimit }),
    /prompt-limit/,
  );
  assert.equal(
    calls.some((url) => url.endsWith('/v1/chat/completions')),
    false,
  );
  let completions = 0;
  const withTool = async (url) => {
    if (url.endsWith('/v1/chat/completions')) completions += 1;
    return {
      ok: true,
      json: async () =>
        url.endsWith('/apply-template')
          ? { prompt: 'formatted' }
          : url.endsWith('/tokenize')
            ? { tokens: [1] }
            : {
                choices: [{ message: { content: 'patch', tool_calls: [{}] } }],
              },
    };
  };
  await assert.rejects(
    performDirectPatch('task', { fetchImpl: withTool }),
    /response-shape/,
  );
  assert.equal(completions, 1);
});

test('client and meter have no workspace, credentials, external network or tools', () => {
  const client = clientContainerArgs(
    '/mnt/d/ai-repositories/stellar-issue-129/tools/policy/context-study/avatar-patch-client.mjs',
  );
  const meter = meterContainerArgs();
  assert.ok(client.includes('--network=stellar-peon-model'));
  assert.ok(client.includes('--network=stellar-peon-worker'));
  assert.ok(meter.includes('--network=stellar-peon-model'));
  assert.ok(meter.includes('--network=stellar-peon-worker:alias=peon-meter'));
  assert.ok(meter.includes('--env=STELLAR_MAX_MODEL_TOKENS=3000'));
  assert.ok(meter.includes('--env=STELLAR_MAX_FORWARDED_REQUESTS=1'));
  for (const args of [client, meter]) {
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop=all'));
    assert.ok(args.includes('--security-opt=no-new-privileges'));
    assert.ok(
      !args.some((arg) =>
        /GH_TOKEN|--secret=|stellar-peon-egress|\/workspace/.test(arg),
      ),
    );
  }
  const verifier = verifierContainerArgs(
    '/mnt/d/ai-repositories/.stellar-supervisor-state/avatar-direct-abc/checkout',
    'test',
  );
  assert.ok(verifier.includes('--network=none'));
  assert.ok(verifier.includes('--read-only'));
  assert.ok(verifier.some((arg) => arg.includes('dst=/workspace,ro')));
  assert.ok(
    verifier.some((arg) =>
      arg.includes('issue-50/node_modules,dst=/workspace/node_modules,ro'),
    ),
  );
  assert.ok(
    !verifier.some((arg) => /GH_TOKEN|--secret=|stellar-peon-model/.test(arg)),
  );
  assert.throws(
    () => verifierContainerArgs('/mnt/d/other', 'test'),
    /isolation/,
  );
  assert.throws(
    () =>
      verifierContainerArgs(
        '/mnt/d/ai-repositories/.stellar-supervisor-state/avatar-direct-abc/checkout',
        'publish',
      ),
    /isolation/,
  );
});

test('one-use reservation survives process restarts and refuses a second run', () => {
  const parent = mkdtempSync(
    path.join(path.dirname(process.cwd()), 'avatar-lock-test-'),
  );
  try {
    const lock = reserveOneUseRun('a'.repeat(40), parent);
    assert.ok(existsSync(lock));
    assert.throws(() => reserveOneUseRun('a'.repeat(40), parent), /EEXIST/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('SIGINT and SIGTERM interrupt the one-use run without exiting before cleanup', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const emitter = new EventEmitter();
    const guard = installInterruptGuard(emitter);
    emitter.emit(signal);
    assert.equal(guard.signal(), signal);
    await assert.rejects(guard.checkpoint(), /interrupted/);
    guard.dispose();
    assert.equal(emitter.listenerCount(signal), 0);
  }
});

test('an interrupt kills an active model client without waiting for its deadline', async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let killed = false;
  child.kill = () => {
    killed = true;
    child.emit('exit', null);
  };
  const started = Date.now();
  const running = runBoundedPodman(
    ['run', '--name=stellar-peon-worker-50-1001'],
    {
      input: '{}',
      timeout: 5_000,
      signal: controller.signal,
      spawnProcess: () => child,
    },
  );
  controller.abort();
  await assert.rejects(running, /interrupted/);
  assert.equal(killed, true);
  assert.ok(Date.now() - started < 500);
});

test('disposable checkout accepts only the two intended patch paths', async () => {
  const parent = mkdtempSync(
    path.join(path.dirname(process.cwd()), 'avatar-patch-test-'),
  );
  const base = git(process.cwd(), ['rev-parse', 'HEAD']);
  let disposable;
  try {
    disposable = makeDisposableCheckout(base, parent);
    assert.equal(git(disposable.checkout, ['status', '--porcelain=v1']), '');
    assert.equal(git(disposable.checkout, ['rev-parse', 'HEAD']), base);
    const sourceFile = path.join(disposable.checkout, avatarSource);
    const testFile = path.join(disposable.checkout, avatarTest);
    const original = readFileSync(sourceFile, 'utf8');
    writeFileSync(
      sourceFile,
      original
        .replace("'text' | 'control'", "'text' | 'control' | 'avatar'")
        .replace(
          "'h-5 w-20': this.shape() === 'control',",
          "'h-5 w-20': this.shape() === 'control',\n      'h-10 w-10 rounded-full': this.shape() === 'avatar',",
        ),
    );
    writeFileSync(
      testFile,
      `import { TestBed } from '@angular/core/testing';\nimport { expect, it } from 'vitest';\nimport { SkeletonAtom } from './skeleton-atom.component';\nit('renders avatar', () => {\n  const fixture = TestBed.createComponent(SkeletonAtom);\n  fixture.componentRef.setInput('shape', 'avatar');\n  fixture.detectChanges();\n  const span = fixture.nativeElement.querySelector('span');\n  expect(span.classList.contains('h-10')).toBe(true);\n  expect(span.classList.contains('w-10')).toBe(true);\n  expect(span.classList.contains('rounded-full')).toBe(true);\n  expect(span.getAttribute('aria-hidden')).toBe('true');\n});\n`,
    );
    git(disposable.checkout, ['add', '-N', avatarTest]);
    const patch =
      git(disposable.checkout, ['diff', '--', avatarSource, avatarTest]) + '\n';
    git(disposable.checkout, ['reset', '--', avatarTest]);
    git(disposable.checkout, ['checkout', '--', avatarSource]);
    rmSync(testFile);
    assert.deepEqual(
      new Set(validateAvatarPatch(patch)),
      new Set([avatarSource, avatarTest]),
    );
    applyAndVerify(disposable.checkout, patch);
    assert.ok(existsSync(testFile));
    if (process.env.STELLAR_BENCHMARK_VERIFY_UI === '1')
      assert.deepEqual(await verifyUi(disposable.checkout), [
        'lint:passed',
        'test:passed',
        'build:passed',
      ]);
    assert.throws(
      () => applyAndVerify(disposable.checkout, patch),
      /scope: focused test already exists/,
    );
  } finally {
    if (disposable) disposeCheckout(disposable, parent);
    rmSync(parent, { recursive: true, force: true });
  }
  assert.ok(!existsSync(parent));
});

test('cleanup starts all stops and never confirms a running or unknown container', async () => {
  const stopped = [];
  const states = new Map();
  const stop = async (args) => {
    const name = args.at(-1);
    stopped.push(name);
    states.set(name, 'stopped');
    return true;
  };
  const confirmed = await confirmBenchmarkCleanup({
    stop,
    inspect: async (name) => states.get(name) ?? 'running',
  });
  assert.equal(confirmed.confirmed, true);
  assert.equal(stopped.length, 3);
  const running = await confirmBenchmarkCleanup({
    stop,
    inspect: async (name) => (name.includes('meter') ? 'running' : 'absent'),
    deadlineAt: Date.now() + 30,
  });
  assert.equal(running.confirmed, false);
  const failed = await confirmBenchmarkCleanup({
    stop,
    inspect: async () => {
      throw new Error('inspect failed');
    },
  });
  assert.equal(failed.confirmed, false);
});

test('cleanup cannot confirm after a delayed inspection consumes the deadline', async () => {
  const startedAt = Date.now();
  const result = await confirmBenchmarkCleanup({
    stop: async () => true,
    inspect: async () => {
      await new Promise((resolve) => setTimeout(resolve, 45));
      return 'stopped';
    },
    deadlineAt: startedAt + 20,
  });
  assert.equal(result.confirmed, false);
});
