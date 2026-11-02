import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installVoiceQualification,
  voiceQualificationPreflight,
} from './voice-qualification-browser.mjs';

test('synthetic media, delegated IPC, bounded safe observation and teardown', async () => {
  const listeners = new Map();
  let originalCapture = 0;
  let nativeCalls = 0;
  let sourceStarts = 0;
  let paneTick;
  let headingText = 'wrong title';
  let paneVisible = false;
  const pane = {
    getAttribute: (name) => (name === 'aria-label' ? 'Text' : null),
    textContent: 'Voice pipeline complete',
    querySelectorAll: () => [{ textContent: headingText }],
    getBoundingClientRect: () => ({
      width: paneVisible ? 100 : 0,
      height: 100,
    }),
  };
  const originals = {
    window: globalThis.window,
    navigator: globalThis.navigator,
    AudioContext: globalThis.AudioContext,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    MutationObserver: globalThis.MutationObserver,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const track = {
    readyState: 'live',
    stop() {
      this.readyState = 'ended';
    },
  };
  class FakeContext {
    currentTime = 0;
    createMediaStreamDestination() {
      return {
        stream: { getAudioTracks: () => [track], getTracks: () => [track] },
      };
    }
    async resume() {
      return undefined;
    }
    async close() {
      return undefined;
    }
    async decodeAudioData() {
      return { duration: 1 };
    }
    createBufferSource() {
      return {
        connect() {
          return undefined;
        },
        start() {
          sourceStarts++;
        },
      };
    }
  }
  const media = {
    async getUserMedia() {
      originalCapture++;
      throw new Error('physical capture');
    },
  };
  const nativeInvoke = async () => null;
  const nativeFetch = async (url) => {
    nativeCalls++;
    const command = url.split('/').pop();
    const body =
      command === 'speech_transcribe'
        ? { text: 'End. Prompt.' }
        : command === 'cleanup_refine'
          ? { text: 'private raw value' }
          : { verified_model: 'sol', private_value: 'never record' };
    return new Response(JSON.stringify(body), {
      headers: { 'Tauri-Response': 'ok', 'content-type': 'application/json' },
    });
  };
  globalThis.window = {
    fetch: nativeFetch,
    __TAURI_INTERNALS__: Object.freeze({
      invoke: nativeInvoke,
      convertFileSrc: (command) => `http://ipc.localhost/${command}`,
    }),
    __TAURI__: {
      event: {
        async listen(name, fn) {
          listeners.set(name, fn);
          return () => listeners.delete(name);
        },
      },
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: media },
  });
  globalThis.AudioContext = FakeContext;
  globalThis.MutationObserver = class {
    observe() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  };
  globalThis.getComputedStyle = (element) => ({
    opacity: element === pane ? '1' : '0',
  });
  globalThis.setInterval = (fn) => {
    paneTick = fn;
    return 1;
  };
  globalThis.clearInterval = () => undefined;
  globalThis.document = {
    documentElement: {},
    querySelectorAll: () => [pane],
    querySelector: () => ({ classList: { contains: () => true } }),
  };
  try {
    await installVoiceQualification();
    const fixture = window.__stellarVoiceQualification;
    assert.equal(fixture.snapshot().installed, true);
    paneTick();
    assert.equal(
      fixture
        .snapshot()
        .events.some((event) => event.kind === 'expected-pane-visible'),
      false,
    );
    headingText = 'Native Voice Check';
    paneTick();
    assert.equal(
      fixture
        .snapshot()
        .events.some((event) => event.kind === 'expected-pane-visible'),
      false,
    );
    paneVisible = true;
    paneTick();
    assert.equal(
      fixture
        .snapshot()
        .events.filter((event) => event.kind === 'expected-pane-visible')
        .length,
      1,
    );
    await assert.rejects(media.getUserMedia({ video: true }));
    assert.equal(originalCapture, 0);
    const stream = await media.getUserMedia({ audio: true, video: false });
    await fixture.arm('AA==', 'prompt');
    await assert.rejects(fixture.arm('AA==', 'prompt'));
    assert.equal(sourceStarts, 1);
    const reply = await window.fetch('http://ipc.localhost/speech_transcribe', {
      body: 'never record',
    });
    assert.equal((await reply.json()).text, 'End. Prompt.');
    await window.fetch('http://ipc.localhost/cleanup_refine', {
      body: 'private raw value',
    });
    await window.fetch('http://ipc.localhost/ivy_submit', {
      body: 'private raw value',
    });
    listeners.get('speech-state')({
      payload: { state: 'speaking', secret: 'never record' },
    });
    for (const payload of [
      {
        state: 'synthesizing',
        epoch: '4',
        operation_id: 'private-operation',
        error: null,
      },
      {
        state: 'speaking',
        epoch: '4',
        operation_id: 'private-operation',
        error: null,
      },
      {
        state: 'idle',
        epoch: '5',
        operation_id: 'private-operation',
        error: 'cancelled',
      },
    ])
      listeners.get('speech-state')({ payload });
    const projected = fixture
      .snapshot()
      .events.filter((event) => event.kind === 'speech-state')
      .slice(-3);
    assert.deepEqual(
      projected.map(({ state, samePlayback, error }) => ({
        state,
        samePlayback,
        error,
      })),
      [
        { state: 'synthesizing', samePlayback: true, error: null },
        { state: 'speaking', samePlayback: true, error: null },
        { state: 'idle', samePlayback: false, error: 'cancelled' },
      ],
    );
    assert.equal(
      JSON.stringify(projected).includes('private-operation'),
      false,
    );
    const trace = fixture.snapshot();
    assert.equal(
      trace.events.find(
        (event) =>
          event.command === 'speech_transcribe' && event.kind === 'result',
      ).recognized,
      'end prompt',
    );
    assert.equal(
      trace.events.find(
        (event) =>
          event.command === 'cleanup_refine' && event.kind === 'result',
      ).cleaned,
      true,
    );
    assert.equal(
      trace.events.find(
        (event) => event.command === 'ivy_submit' && event.kind === 'invoke',
      ).dissolved,
      true,
    );
    assert.equal(JSON.stringify(trace).includes('private raw value'), false);
    assert.equal(JSON.stringify(trace).includes('never record'), false);
    assert.equal(nativeCalls, 3);
    stream.getTracks()[0].stop();
    stream.getTracks()[0].stop();
    assert.equal(fixture.snapshot().active, 0);
    assert.equal(
      fixture.snapshot().events.find((event) => event.kind === 'track-stopped')
        .ended,
      true,
    );
    await fixture.dispose();
    await assert.rejects(media.getUserMedia({ audio: true }));
    assert.equal(originalCapture, 0);
    assert.equal(window.fetch, nativeFetch);
    assert.equal(window.__TAURI_INTERNALS__.invoke, nativeInvoke);
  } finally {
    globalThis.window = originals.window;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originals.navigator,
    });
    globalThis.AudioContext = originals.AudioContext;
    globalThis.MutationObserver = originals.MutationObserver;
    globalThis.document = originals.document;
    globalThis.getComputedStyle = originals.getComputedStyle;
    globalThis.setInterval = originals.setInterval;
    globalThis.clearInterval = originals.clearInterval;
  }
});

test('installation failure after replacing capture leaves no physical fallback', async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;
  const originalObserver = globalThis.MutationObserver;
  let physicalCalls = 0;
  const media = {
    async getUserMedia() {
      physicalCalls++;
      return null;
    },
  };
  globalThis.window = {
    fetch: async () => null,
    __TAURI_INTERNALS__: Object.freeze({
      invoke: async () => null,
      convertFileSrc: (command) => `http://ipc.localhost/${command}`,
    }),
    __TAURI__: {
      event: {
        async listen() {
          throw new Error('listener failure');
        },
      },
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: media },
  });
  globalThis.document = { documentElement: {} };
  globalThis.MutationObserver = class {
    observe() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  };
  try {
    await assert.rejects(installVoiceQualification());
    await assert.rejects(media.getUserMedia({ audio: true }));
    assert.equal(physicalCalls, 0);
    assert.equal(window.__stellarVoiceQualification, undefined);
  } finally {
    globalThis.window = originalWindow;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    globalThis.document = originalDocument;
    globalThis.MutationObserver = originalObserver;
  }
});

test('preflight rejects retained drafts and non-idle composition before capture hook', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const composition = {
    status: 'idle',
    raw: '',
    refined: null,
    lastSubmittedRaw: '',
  };
  globalThis.document = {
    querySelector: () => ({}),
    querySelectorAll: (selector) =>
      selector === 'button' ? [{ textContent: 'Enable microphone' }] : [],
  };
  globalThis.window = {
    ng: { getComponent: () => ({ voice: { composition: () => composition } }) },
  };
  try {
    assert.equal(voiceQualificationPreflight(), true);
    for (const [key, value] of [
      ['raw', 'retained'],
      ['refined', 'retained'],
      ['lastSubmittedRaw', 'retained'],
      ['status', 'composing'],
    ]) {
      const previous = composition[key];
      composition[key] = value;
      assert.equal(voiceQualificationPreflight(), false);
      composition[key] = previous;
    }
    delete window.ng;
    assert.equal(voiceQualificationPreflight(), false);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});
