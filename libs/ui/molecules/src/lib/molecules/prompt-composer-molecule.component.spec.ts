import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptComposerMolecule } from './prompt-composer-molecule.component';
import { promptTextEdit } from './prompt-composer-text';

describe('PromptComposerMolecule', () => {
  let fixture: ComponentFixture<PromptComposerMolecule>;
  const animations: {
    finish: () => void;
    cancel: ReturnType<typeof vi.fn>;
    frames: Keyframe[];
    duration: number;
  }[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const previousAnimate = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'animate',
  );

  beforeEach(async () => {
    animations.length = 0;
    frames.clear();
    nextFrame = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 60,
      top: 0,
      left: 0,
      right: 800,
      bottom: 60,
      toJSON: () => ({}),
    });
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: vi.fn(
        (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
          let finish!: () => void, fail!: (error: Error) => void;
          const finished = new Promise<void>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
          const cancel = vi.fn(() =>
            fail(new DOMException('Cancelled', 'AbortError')),
          );
          animations.push({
            finish,
            cancel,
            frames: keyframes,
            duration: Number(options.duration),
          });
          return { finished, cancel } as unknown as Animation;
        },
      ),
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    await TestBed.configureTestingModule({
      imports: [PromptComposerMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(PromptComposerMolecule);
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('status', 'composing');
    fixture.componentRef.setInput('raw', 'Keep <script> words');
    await fixture.whenStable();
  });
  afterEach(() => {
    fixture.destroy();
    if (previousAnimate)
      Object.defineProperty(Element.prototype, 'animate', previousAnimate);
    else Reflect.deleteProperty(Element.prototype, 'animate');
    vi.restoreAllMocks();
  });
  async function open() {
    expect(animations).toHaveLength(4);
    animations.forEach((animation) => animation.finish());
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.opened')).not.toBeNull();
    });
    animations.length = 0;
  }
  async function tick(time: number) {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(time));
    await fixture.whenStable();
  }
  async function begin(reduced = false) {
    await open();
    fixture.componentRef.setInput('status', 'finalizing');
    fixture.componentRef.setInput('refined', 'Keep corrected words');
    fixture.componentRef.setInput('reducedMotion', reduced);
    await fixture.whenStable();
    const controller = new AbortController();
    const completion = fixture.componentInstance.presentFinalized(
      { raw: 'Keep <script> words', refined: 'Keep corrected words' },
      controller.signal,
    );
    await fixture.whenStable();
    return { controller, completion };
  }
  it('opens braces from the shared center with a tone between them and plain literal text', async () => {
    expect(animations.every((animation) => animation.duration === 1000)).toBe(
      true,
    );
    expect(animations[0].frames[0]).toEqual({
      left: 'calc(50% - 0.75rem)',
      opacity: 0,
    });
    expect(animations[1].frames[0]).toEqual({
      right: 'calc(50% - 0.75rem)',
      opacity: 0,
    });
    expect(animations[2].frames[0]).toEqual({
      transform: 'scaleX(0)',
      opacity: 0,
    });
    expect(fixture.nativeElement.querySelectorAll('.brace')).toHaveLength(2);
    expect(
      fixture.nativeElement.querySelector('script,textarea,input,button'),
    ).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Keep <script> words');
    await open();
  });
  it('edits characters on render frames and waits for every reverse brace animation before completion', async () => {
    const { completion } = await begin();
    const complete = vi.fn();
    void completion.then(complete);
    await tick(0);
    await tick(500);
    expect(fixture.componentInstance.displayText()).not.toBe(
      'Keep <script> words',
    );
    expect(fixture.componentInstance.displayText()).not.toBe(
      'Keep corrected words',
    );
    expect(animations).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    await tick(1000);
    expect(animations).toHaveLength(0);
    await tick(1001);
    await tick(2000);
    expect(animations).toHaveLength(0);
    await tick(2001);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(animations).toHaveLength(4);
    });
    expect(fixture.componentInstance.displayText()).toBe(
      'Keep corrected words',
    );
    expect(animations.every((animation) => animation.duration === 1000)).toBe(
      true,
    );
    expect(animations[0].frames.at(-1)).toEqual({
      left: 'calc(50% - 0.75rem)',
      opacity: 0,
    });
    expect(animations[3].frames.at(-1)).toEqual({
      opacity: 0,
      clipPath: 'inset(0 50%)',
    });
    animations.slice(0, 3).forEach((animation) => animation.finish());
    await fixture.whenStable();
    expect(complete).not.toHaveBeenCalled();
    animations[3].finish();
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(complete).toHaveBeenCalledOnce();
    });
    await completion;
    expect(fixture.nativeElement.querySelector('.dissolved')).not.toBeNull();
  });
  it('cancels character editing without starting closure or accepting a late frame', async () => {
    const { controller, completion } = await begin();
    const result = completion.catch((error) => error.name);
    await tick(0);
    await tick(100);
    const retained = fixture.componentInstance.displayText();
    controller.abort();
    expect(await result).toBe('AbortError');
    await tick(3000);
    expect(fixture.componentInstance.displayText()).toBe(retained);
    expect(animations).toHaveLength(0);
    expect(frames.size).toBe(0);
  });
  it('cancels reverse closure and retains corrected text in the error state', async () => {
    const { controller, completion } = await begin();
    const result = completion.catch((error) => error.name);
    await tick(0);
    await tick(1000);
    await tick(1001);
    await tick(2001);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(animations).toHaveLength(4);
    });
    controller.abort();
    expect(await result).toBe('AbortError');
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
    fixture.componentRef.setInput('status', 'error');
    await fixture.whenStable();
    expect(fixture.componentInstance.displayText()).toBe(
      'Keep corrected words',
    );
    expect(fixture.nativeElement.querySelector('.dissolved')).toBeNull();
  });
  it('aborts the handoff if hidden during character editing', async () => {
    const { completion } = await begin();
    const result = completion.catch((error) => error.name);
    await tick(0);
    fixture.componentRef.setInput('visible', false);
    await fixture.whenStable();
    expect(await result).toBe('AbortError');
    expect(frames.size).toBe(0);
  });
  it('renders reduced-motion finalization without character frames or closure animations', async () => {
    const { completion } = await begin(true);
    let done = false;
    void completion.then(() => (done = true));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(done).toBe(true);
    });
    await completion;
    expect(animations).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect(fixture.componentInstance.displayText()).toBe(
      'Keep corrected words',
    );
  });
  it('cancels opening when hidden and shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('visible', false);
    await fixture.whenStable();
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
    fixture.componentRef.setInput('loading', true);
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
  });

  it('shows actual preview, refines for one second without closing, and commits new words once', async () => {
    await open();
    fixture.componentRef.setInput('raw', 'Um, first sentence.');
    fixture.componentRef.setInput('draft', 'Um, first sentence.');
    fixture.componentRef.setInput('preview', 'More words');
    await fixture.whenStable();
    expect(fixture.componentInstance.displayText()).toBe(
      'Um, first sentence. More words',
    );
    fixture.componentRef.setInput('draft', 'first sentence.');
    fixture.componentRef.setInput('refined', 'first sentence.');
    fixture.componentRef.setInput('refinementRevision', 1);
    await fixture.whenStable();
    await tick(0);
    await tick(500);
    expect(fixture.componentInstance.displayText()).toContain('More words');
    expect(fixture.componentInstance.displayText()).not.toBe(
      'first sentence. More words',
    );
    expect(animations).toHaveLength(0);
    await tick(999);
    expect(fixture.componentInstance.draftEditing()).toBe(true);
    await tick(1000);
    expect(fixture.componentInstance.displayText()).toBe(
      'first sentence. More words',
    );
    expect(fixture.componentInstance.raw()).toBe('Um, first sentence.');
    fixture.componentRef.setInput('raw', 'Um, first sentence.\nMore words.');
    fixture.componentRef.setInput('draft', 'first sentence.\nMore words.');
    fixture.componentRef.setInput('preview', '');
    await fixture.whenStable();
    expect(fixture.componentInstance.displayText()).toBe(
      'first sentence.\nMore words.',
    );
    expect(fixture.nativeElement.querySelector('.opened')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.dissolved')).toBeNull();
  });

  it('preserves new dictation when it interrupts an older correction', async () => {
    await open();
    fixture.componentRef.setInput('draft', 'Um, first sentence.');
    await fixture.whenStable();
    fixture.componentRef.setInput('draft', 'first sentence.');
    fixture.componentRef.setInput('refinementRevision', 1);
    await fixture.whenStable();
    await tick(0);
    await tick(250);
    fixture.componentRef.setInput('draft', 'first sentence.\nNew words.');
    await fixture.whenStable();
    expect(fixture.componentInstance.displayText()).toBe(
      'first sentence.\nNew words.',
    );
    await tick(3000);
    expect(fixture.componentInstance.displayText()).toBe(
      'first sentence.\nNew words.',
    );
    expect(frames.size).toBe(0);
    expect(animations).toHaveLength(0);
  });

  it('cancels the corrected-text hold without closing or completing submission', async () => {
    const { controller, completion } = await begin();
    const result = completion.catch((error) => error.name);
    await tick(0);
    await tick(1000);
    await tick(1001);
    await tick(1500);
    expect(animations).toHaveLength(0);
    controller.abort();
    expect(await result).toBe('AbortError');
    await tick(3000);
    expect(animations).toHaveLength(0);
    expect(frames.size).toBe(0);
  });
});

describe('prompt text edits', () => {
  it('removes a leading filler one character at a time without rewriting the unchanged suffix', () => {
    const edit = promptTextEdit('Um, keep this.', 'keep this.');
    expect(edit.steps).toBe(4);
    expect([0, 1, 2, 3, 4].map((step) => edit.at(step))).toEqual([
      'Um, keep this.',
      'Um,keep this.',
      'Umkeep this.',
      'Ukeep this.',
      'keep this.',
    ]);
  });
  it('preserves complete grapheme clusters while replacing an internal correction', () => {
    const edit = promptTextEdit('Keep 👩‍💻x.', 'Keep 👩‍💻y.');
    expect(edit.steps).toBe(2);
    expect(edit.at(1)).toBe('Keep 👩‍💻.');
    expect(edit.at(2)).toBe('Keep 👩‍💻y.');
  });
});
