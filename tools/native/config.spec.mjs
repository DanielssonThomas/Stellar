import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const rejectedSmokeCommands = [
  ['ivy/mod.rs', 'ivy_connect', 'IvyErrorCode', false],
  ['ivy/mod.rs', 'ivy_submit', 'IvyErrorCode', false],
  ['ivy/mod.rs', 'ivy_cancel', 'IvyErrorCode', false],
  ['ivy/mod.rs', 'ivy_reconcile', 'IvyErrorCode', false],
  ['ivy/mod.rs', 'workspace_tool_reply', 'IvyErrorCode', false],
  ['speech/mod.rs', 'speech_keywords', 'SpeechError', true],
  ['speech/mod.rs', 'speech_transcribe', 'SpeechError', true],
  ['speech/mod.rs', 'speech_collect', 'SpeechError', true],
];

function requireSmokeGuard(source, command, error, recognitionAllowed) {
  const signature = new RegExp(
    `pub (?:async )?fn ${command}\\([\\s\\S]*?\\) -> [^{]+\\{([\\s\\S]*?)\\n\\}`,
  );
  const body = signature.exec(source)?.[1].replace(/\s+/g, '');
  const condition = recognitionAllowed
    ? 'all(feature = "native-smoke", not(feature = "recognition-smoke"))'
    : 'feature = "native-smoke"';
  assert.ok(
    body?.startsWith(
      `if cfg!(${condition}) { return Err(${error}::Unavailable); }`.replace(
        /\s+/g,
        '',
      ),
    ),
    `${command} must reject ordinary smoke BEFORE host access or effects`,
  );
}

test('smoke-only operational rejection is independent of capabilities and preserves recognition mode', () => {
  const smoke = readFileSync(
    new URL(
      '../../apps/stellar-desktop/src-tauri/src/smoke.rs',
      import.meta.url,
    ),
    'utf8',
  );
  const runner = readFileSync(new URL('./cargo.mjs', import.meta.url), 'utf8');
  const recognition = readFileSync(
    new URL(
      '../../apps/stellar-desktop/src-tauri/src/recognition_smoke.rs',
      import.meta.url,
    ),
    'utf8',
  );
  for (const [
    file,
    command,
    error,
    recognitionAllowed,
  ] of rejectedSmokeCommands) {
    const source = readFileSync(
      new URL(
        `../../apps/stellar-desktop/src-tauri/src/${file}`,
        import.meta.url,
      ),
      'utf8',
    );
    requireSmokeGuard(source, command, error, recognitionAllowed);
    assert.throws(() =>
      requireSmokeGuard(
        source.replaceAll(
          `return Err(${error}::Unavailable);`,
          '/* missing denial */',
        ),
        command,
        error,
        recognitionAllowed,
      ),
    );
    assert.ok(smoke.includes(`::${command},`));
    assert.ok(!runner.includes(`'allow-${command.replaceAll('_', '-')}'`));
  }
  for (const command of ['speech_keywords', 'speech_transcribe'])
    assert.ok(recognition.includes(`::${command},`));
});

const project = JSON.parse(
  readFileSync(
    new URL('../../apps/stellar-desktop/project.json', import.meta.url),
  ),
);
const config = JSON.parse(
  readFileSync(
    new URL(
      '../../apps/stellar-desktop/src-tauri/tauri.conf.json',
      import.meta.url,
    ),
  ),
);
const capability = JSON.parse(
  readFileSync(
    new URL(
      '../../apps/stellar-desktop/src-tauri/capabilities/main.json',
      import.meta.url,
    ),
  ),
);

function assertCacheInputs(candidate) {
  for (const path of [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    'tools/native/**/*',
    'libs/desktop-contracts/**/*',
    'docs/architecture/rust-tauri.md',
  ])
    assert.ok(
      candidate.namedInputs.native.includes(`{workspaceRoot}/${path}`),
      `Missing native input: ${path}`,
    );
  assert.ok(
    candidate.namedInputs.native.includes('{projectRoot}/src-tauri/**/*'),
  );
  for (const target of [
    'native-fmt',
    'native-clippy',
    'native-test',
    'contract-check',
    'native-build',
    'native-smoke',
    'rust-size-check',
  ])
    assert.ok(
      candidate.targets[target].inputs.includes('native'),
      `${target} omits native inputs`,
    );
  assert.equal(candidate.targets['native-smoke'].cache, false);
  assert.equal(candidate.targets['native-launch'].cache, false);
  assert.deepEqual(candidate.targets['native-smoke'].dependsOn, [
    'native-build',
  ]);
  assert.deepEqual(candidate.targets['native-build'].dependsOn, ['build']);
  assert.ok(
    candidate.targets['rust-size-check'].inputs.includes(
      '{workspaceRoot}/**/*.rs',
    ),
  );
  assert.ok(
    candidate.targets['rust-size-check'].inputs.includes(
      '{workspaceRoot}/.gitignore',
    ),
  );
  assert.ok(
    candidate.targets['native-build'].outputs.includes(
      '{workspaceRoot}/target/debug/stellar-desktop.exe',
    ),
  );
}

test('native checks hash manifests, locks, toolchain, source, contracts and policy', () => {
  assertCacheInputs(project);
});

test('missing locks, source globs, build dependencies and cached smoke are rejected', () => {
  for (const input of [
    '{workspaceRoot}/Cargo.lock',
    '{workspaceRoot}/rust-toolchain.toml',
    '{projectRoot}/src-tauri/**/*',
  ]) {
    const fixture = structuredClone(project);
    fixture.namedInputs.native = fixture.namedInputs.native.filter(
      (value) => value !== input,
    );
    assert.throws(() => assertCacheInputs(fixture));
  }
  const cachedSmoke = structuredClone(project);
  cachedSmoke.targets['native-smoke'].cache = true;
  assert.throws(() => assertCacheInputs(cachedSmoke));
  const skippedBuild = structuredClone(project);
  skippedBuild.targets['native-build'].dependsOn = [];
  assert.throws(() => assertCacheInputs(skippedBuild));
});

test('normal host keeps decorations and only its explicit local commands', () => {
  assert.equal(
    project.targets.build.configurations.production.optimization.styles
      .inlineCritical,
    false,
  );
  assert.equal(config.app.windows[0].decorations, true);
  assert.equal(config.app.windows[0].resizable, true);
  assert.equal(config.app.windows[0].devtools, false);
  assert.deepEqual(config.app.security.capabilities, ['desktop-main']);
  assert.deepEqual(capability.permissions, [
    'allow-reflex-infer',
    'allow-reflex-route',
    'allow-reflex-prepare',
    'allow-reflex-status',
    'allow-reflex-set-enabled',
    'allow-reflex-cancel',
    'allow-reflex-media-snapshot',
    'allow-reflex-media-execute',
    'allow-music-set-enabled',
    'allow-shell-status',
    'allow-awareness-snapshot',
    'allow-awareness-set-enabled',
    'allow-awareness-workspace',
    'allow-cleanup-refine',
    'allow-app-info',
    'allow-telemetry-snapshot',
    'allow-ivy-connect',
    'allow-ivy-snapshot',
    'allow-ivy-inspect',
    'allow-ivy-submit',
    'allow-ivy-cancel',
    'allow-ivy-reconcile',
    'allow-ivy-disconnect',
    'allow-ivy-select-session',
    'allow-ivy-clear-conversation',
    'allow-ivy-new-session',
    'allow-ivy-reload-mcp',
    'allow-ivy-question-reply',
    'allow-ivy-claim-update',
    'allow-workspace-tool-reply',
    'allow-speech-transcribe',
    'allow-speech-collect',
    'allow-speech-keywords',
    'allow-speech-speak',
    'allow-speech-stop',
    'allow-speech-snapshot',
    'allow-speech-set-ducking',
    'core:event:allow-listen',
    'core:event:allow-unlisten',
    'allow-workspace-browser',
    'allow-workspace-image',
  ]);
  assert.equal(capability.remote, undefined);
  assert.deepEqual(capability.webviews, ['main']);
  assert.equal(capability.windows, undefined);
  assert.match(config.app.security.csp, /script-src 'self';/);
  assert.doesNotMatch(
    config.app.security.csp,
    /unsafe-eval|unsafe-inline|https:|\*/,
  );
});

test('owned Ivy cleanup is connected to window destruction and app exit', () => {
  const source = readFileSync(
    new URL(
      '../../apps/stellar-desktop/src-tauri/src/main.rs',
      import.meta.url,
    ),
    'utf8',
  );
  for (const event of ['WindowEvent::Destroyed', 'RunEvent::Exit']) {
    assert.ok(source.includes(`matches!(event, tauri::${event})`));
  }
  assert.match(source, /\.build\(tauri::generate_context!\(\)\)/);
  assert.match(
    source,
    /\.run\(\|app, event\|\s*\{[\s\S]*?RunEvent::Exit[\s\S]*?app\.try_state::<ivy::IvyHost>\(\)[\s\S]*?host\.shutdown\(\)/,
  );
  for (const host of [
    'reflex::ReflexHost',
    'std::sync::Arc<reflex::MediaHost>',
  ]) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const event of ['WindowEvent::Destroyed', 'RunEvent::Exit']) {
      assert.match(
        source,
        new RegExp(
          `${event}[\\s\\S]*?try_state::<${escaped}>\\(\\)[\\s\\S]*?host\\.shutdown\\(\\)`,
        ),
      );
    }
  }
});
