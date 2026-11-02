import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AudioActivityService } from '@stellar/service-audio-activity';
import {
  IvyAdapterService,
  SpeechAdapterService,
  initialIvySnapshot,
  initialSpeechSnapshot,
} from '@stellar/service-desktop-adapter';
import { describe, expect, it, vi } from 'vitest';
import { DesktopAssistant } from './desktop-assistant';
import { DesktopExperience } from './desktop-experience';
import { DesktopVoice } from './desktop-voice';

function fixture(snapshot: ReturnType<typeof vi.fn>) {
  const ivy = {
    snapshot,
    selectSession: vi.fn(async () => true),
    clearConversation: vi.fn(async () => true),
  };
  TestBed.configureTestingModule({
    providers: [
      DesktopVoice,
      { provide: IvyAdapterService, useValue: ivy },
      {
        provide: AudioActivityService,
        useValue: {
          state: signal({ status: 'idle' }),
          subscribePcm: () => () => undefined,
        },
      },
      {
        provide: SpeechAdapterService,
        useValue: {
          state: signal(initialSpeechSnapshot()),
          stop: vi.fn(async () => undefined),
        },
      },
      {
        provide: DesktopAssistant,
        useValue: { state: signal(initialIvySnapshot()), submit: vi.fn() },
      },
      {
        provide: DesktopExperience,
        useValue: { state: signal({ phase: 'idle' }) },
      },
    ],
  });
  return { voice: TestBed.inject(DesktopVoice), ivy };
}

describe('desktop voice session composition', () => {
  it('loads a persisted model without overwriting a draft edited while the snapshot is pending', async () => {
    let resolve!: (value: ReturnType<typeof initialIvySnapshot>) => void;
    const snapshot = vi.fn(
      () =>
        new Promise<ReturnType<typeof initialIvySnapshot>>((done) => {
          resolve = done;
        }),
    );
    const { voice } = fixture(snapshot);
    voice.setDraft('keep this draft');
    resolve({ ...initialIvySnapshot(), model: 'sol' });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(voice.composition().raw).toBe('keep this draft');
    expect(voice.composition().model).toBe('sol');
    TestBed.resetTestingModule();
  });

  it('restores persisted Sol and clears the foreground only after a confirmed reset', async () => {
    const { voice, ivy } = fixture(
      vi.fn(async () => ({ ...initialIvySnapshot(), model: 'sol' })),
    );
    await vi.waitFor(() => expect(voice.composition().model).toBe('sol'));
    const clear = vi.fn();
    voice.bindForegroundClear(clear);
    voice.setDraft('unsent');
    ivy.clearConversation.mockResolvedValueOnce(false);
    expect(await voice.resetConversation()).toBe(false);
    expect(voice.composition().raw).toBe('unsent');
    expect(clear).not.toHaveBeenCalled();
    expect(await voice.resetConversation()).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(voice.composition().raw).toBe('');
    expect(voice.composition().model).toBe('terra');
    TestBed.resetTestingModule();
  });

  it('refuses an unsettled or failed fresh snapshot during explicit refresh', async () => {
    const snapshot = vi.fn(async () => initialIvySnapshot());
    const { voice } = fixture(snapshot);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    voice.setDraft('retained');
    snapshot.mockResolvedValueOnce({
      ...initialIvySnapshot(),
      turn: 'uncertain',
    });
    expect(await voice.refreshSession()).toBe(false);
    snapshot.mockRejectedValueOnce(new Error('busy'));
    expect(await voice.refreshSession()).toBe(false);
    expect(voice.composition().raw).toBe('retained');
    TestBed.resetTestingModule();
  });

  it('keeps voice unavailable after a failed startup snapshot until a successful refresh', async () => {
    const snapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(initialIvySnapshot());
    const { voice } = fixture(snapshot);
    await vi.waitFor(() => expect(voice.state().error).toBe(true));
    expect(await voice.refreshSession()).toBe(true);
    expect(voice.state().error).toBe(false);
    expect(voice.composition()).toMatchObject({
      raw: '',
      status: 'idle',
      error: '',
    });
    TestBed.resetTestingModule();
  });
});
