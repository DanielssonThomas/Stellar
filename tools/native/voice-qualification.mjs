#!/usr/bin/env node
/** Explicit native qualification only. Does not launch an app or operate its controls. */
import { readFile, open } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import {
  installVoiceQualification,
  voiceQualificationPreflight,
} from './voice-qualification-browser.mjs';
import {
  assessVoiceQualification,
  parseLoopbackEndpoint,
  verifyOfflineFixture,
  verifyOfflineControls,
  waitForVoiceObservation,
} from './voice-qualification-core.mjs';

function options(argv) {
  if (argv.length !== 11 || argv[0] !== '--run-synthetic')
    throw new Error(
      'Expected --run-synthetic --endpoint URL --target-id ID --fixtures DIRECTORY --offline-receipt FILE --output FILE',
    );
  const result = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i];
    if (
      ![
        '--endpoint',
        '--target-id',
        '--fixtures',
        '--offline-receipt',
        '--output',
      ].includes(key) ||
      result[key]
    )
      throw new Error('Invalid arguments');
    result[key] = argv[i + 1];
  }
  result['--endpoint'] = parseLoopbackEndpoint(result['--endpoint']);
  if (!/^[A-Fa-f0-9-]{1,128}$/.test(result['--target-id']))
    throw new Error('Invalid target ID');
  return result;
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const args = options(process.argv.slice(2));
  const directory = resolve(args['--fixtures']);
  const receipt = JSON.parse(
    await readFile(resolve(args['--offline-receipt']), 'utf8'),
  );
  const worker = await readFile(
    new URL(
      '../../apps/stellar-desktop/src-tauri/src/speech/speech_worker.py',
      import.meta.url,
    ),
  );
  if (
    receipt.synthetic !== true ||
    receipt.worker_sha256 !== digest(worker) ||
    !Array.isArray(receipt.records)
  )
    throw new Error('Offline receipt does not match current worker');
  const negative = receipt.records.find(
    (row) => row.fixture === 'negative-and-prompt',
  );
  if (
    typeof negative?.file_name !== 'string' ||
    !/^[a-z0-9-]+\.wav$/.test(negative.file_name)
  )
    throw new Error('Invalid negative fixture');
  const negativeBytes = await readFile(resolve(directory, negative.file_name));
  if (
    negativeBytes.length > 2_000_000 ||
    !verifyOfflineControls(receipt, digest(negativeBytes))
  )
    throw new Error('Offline negative controls failed');
  const clips = [];
  for (const [label, fixture] of [
    ['prompt', 'prompt'],
    ['content-1', 'content-1'],
    ['content-2', 'content-2-variation'],
    ['finalize', 'finalize'],
  ]) {
    const row = receipt.records.find((record) => record.fixture === fixture);
    const name = row?.file_name;
    if (typeof name !== 'string' || !/^[a-z0-9-]+\.wav$/.test(name))
      throw new Error('Invalid fixture name');
    const bytes = await readFile(resolve(directory, name));
    if (
      bytes.length < 44 ||
      bytes.length > 2_000_000 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE'
    )
      throw new Error('Fixture is not a bounded WAV');
    const sha256 = digest(bytes);
    if (!verifyOfflineFixture(receipt, digest(worker), label, sha256))
      throw new Error('Offline fixture verification failed');
    clips.push({ label, sha256, base64: bytes.toString('base64') });
  }
  const output = resolve(args['--output']);
  if (!basename(output).endsWith('.json'))
    throw new Error('Receipt must be JSON');
  const file = await open(output, 'wx');
  let browser;
  let page;
  let installed = false;
  let snapshot;
  let errorCode = null;
  let teardownActive = null;
  try {
    browser = await chromium.connectOverCDP(args['--endpoint']);
    const matches = [];
    for (const context of browser.contexts())
      for (const candidate of context.pages()) {
        const session = await context.newCDPSession(candidate);
        const info = await session.send('Target.getTargetInfo');
        await session.detach();
        if (info.targetInfo.targetId === args['--target-id'])
          matches.push(candidate);
      }
    if (matches.length !== 1)
      throw new Error('Owned native target not found uniquely');
    page = matches[0];
    const safe = await page.evaluate(voiceQualificationPreflight);
    if (!safe)
      throw new Error(
        'Open the native controls with microphone disabled first',
      );
    await page.evaluate(installVoiceQualification);
    installed = true;
    console.log(
      JSON.stringify({
        ready: true,
        synthetic: true,
        instruction: 'Enable microphone in the owned native window.',
      }),
    );
    const waitFor = (predicate, timeoutMs) =>
      waitForVoiceObservation(page, predicate, timeoutMs, (value) => {
        snapshot = value;
      });
    const has = (state, predicate) => state.events.some(predicate);
    const arm = async (index) =>
      page.evaluate(
        ({ base64, label }) =>
          window.__stellarVoiceQualification.arm(base64, label),
        clips[index],
      );
    snapshot = await waitFor(
      (state) => state.active === 1 && state.acquisitions === 1,
    );
    await arm(0);
    snapshot = await waitFor(
      (state) =>
        state.active === 1 &&
        state.acquisitions === 2 &&
        has(
          state,
          (event) =>
            event.kind === 'result' &&
            event.command === 'speech_transcribe' &&
            event.ok &&
            event.recognized === 'prompt',
        ),
    );
    await arm(1);
    snapshot = await waitFor(
      (state) =>
        has(
          state,
          (event) =>
            event.kind === 'fixture-ended' && event.label === 'content-1',
        ) &&
        state.active === 1 &&
        state.acquisitions === 2 &&
        state.composing,
    );
    if (
      has(
        snapshot,
        (event) => event.kind === 'invoke' && event.command === 'ivy_submit',
      )
    )
      throw new Error('Premature submission');
    await arm(2);
    snapshot = await waitFor((state) => {
      const commits = state.events.filter(
        (event) => event.kind === 'draft-commit' && event.length > 0,
      );
      const latest = commits.at(-1);
      const first = state.events.find(
        (event) =>
          event.kind === 'invoke' &&
          event.cleanupStage === 'first' &&
          Number.isSafeInteger(event.cleanupId),
      );
      const firstOk =
        first &&
        has(
          state,
          (event) =>
            event.kind === 'result' &&
            event.command === 'cleanup_refine' &&
            event.cleanupId === first.cleanupId &&
            event.ok &&
            event.cleaned,
        );
      const latestRefined =
        latest?.fullIntent &&
        has(
          state,
          (event) =>
            event.kind === 'draft-refined' &&
            event.active === 1 &&
            event.fullIntent &&
            event.rawLength === latest.length &&
            event.at >= latest.at &&
            Number.isSafeInteger(event.cleanupId) &&
            has(
              state,
              (result) =>
                result.kind === 'result' &&
                result.command === 'cleanup_refine' &&
                result.cleanupId === event.cleanupId &&
                result.ok &&
                result.cleaned &&
                result.at <= event.at,
            ),
        );
      return (
        state.active === 1 &&
        state.acquisitions === 2 &&
        has(
          state,
          (event) =>
            event.kind === 'fixture-ended' && event.label === 'content-2',
        ) &&
        commits.length >= 2 &&
        commits.every((event) => event.appendOnly && event.noDuplicates) &&
        !!firstOk &&
        !!latestRefined
      );
    });
    if (
      has(
        snapshot,
        (event) => event.kind === 'invoke' && event.command === 'ivy_submit',
      )
    )
      throw new Error('Premature submission');
    await arm(3);
    snapshot = await waitFor(
      (state) => assessVoiceQualification(state).passed,
      180000,
    );
  } catch {
    errorCode = 'qualification_failed';
    if (page && installed) {
      const latest = await page
        .evaluate(() => window.__stellarVoiceQualification.snapshot())
        .catch(() => undefined);
      if (latest) snapshot = latest;
    }
  } finally {
    if (page && installed)
      teardownActive = await page
        .evaluate(async () => {
          await window.__stellarVoiceQualification.dispose();
          return window.__stellarVoiceQualification.snapshot().active;
        })
        .catch(() => null);
    if (browser) await browser.close().catch(() => undefined);
    const result = {
      synthetic: true,
      physicalMicrophone: false,
      fixtures: clips.map(({ label, sha256 }) => ({ label, sha256 })),
      workerSha256: digest(worker),
      configuredModels: {
        speechRecognition: 'Whisper base CPU int8',
        promptCleanup: 'Qwen3.5-9B-Q5_K_S',
        requestedIvy: 'gpt-6.1-sol',
        speechSynthesis: 'Kokoro af_heart',
      },
      teardownActive,
      trace: snapshot ?? null,
      assessment: snapshot
        ? assessVoiceQualification(snapshot)
        : { passed: false },
      error: errorCode,
    };
    if (teardownActive !== 0) {
      result.assessment.passed = false;
      result.assessment.failures = [
        ...(result.assessment.failures ?? []),
        'teardown-unconfirmed',
      ];
    }
    await file.writeFile(JSON.stringify(result, null, 2));
    await file.close();
    console.log(
      JSON.stringify({ passed: result.assessment.passed, error: errorCode }),
    );
    if (!result.assessment.passed) process.exitCode = 1;
  }
}
await main().catch(() => {
  console.error('Qualification preflight failed');
  process.exitCode = 1;
});
