import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptComposerMolecule } from './prompt-composer-molecule.component';

describe('PromptComposerMolecule', () => {
  let fixture: ComponentFixture<PromptComposerMolecule>;
  const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] =
    [];
  const previousAnimate = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'animate',
  );

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PromptComposerMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(PromptComposerMolecule);
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('status', 'composing');
    fixture.componentRef.setInput('raw', 'Literal <script> words');
    await fixture.whenStable();
    animations.length = 0;
    const animate = vi.fn(() => {
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const finished = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const cancel = vi.fn(() =>
        fail(new DOMException('Cancelled', 'AbortError')),
      );
      animations.push({ finish, cancel });
      return { finished, cancel } as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
  });
  afterEach(() => {
    fixture.destroy();
    if (previousAnimate)
      Object.defineProperty(HTMLElement.prototype, 'animate', previousAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    vi.restoreAllMocks();
  });

  it('renders its content', () => {
    expect(fixture.nativeElement.textContent).toContain(
      'Literal <script> words',
    );
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.brace')).toHaveLength(2);
    expect(
      fixture.nativeElement.querySelector('textarea, button, input'),
    ).toBeNull();
  });

  async function begin(reduced = false) {
    fixture.componentRef.setInput('status', 'finalizing');
    fixture.componentRef.setInput('refined', 'Cleaned words');
    fixture.componentRef.setInput('reducedMotion', reduced);
    await fixture.whenStable();
    const controller = new AbortController();
    const completion = fixture.componentInstance.presentFinalized(
      { raw: 'Literal <script> words', refined: 'Cleaned words' },
      controller.signal,
    );
    return { controller, completion };
  }

  it('completes only after the text transition and subsequent brace dissolution finish', async () => {
    const { completion } = await begin();
    const complete = vi.fn();
    void completion.then(complete);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(animations).toHaveLength(2);
    });
    expect(complete).not.toHaveBeenCalled();
    animations[0].finish();
    await fixture.whenStable();
    expect(animations).toHaveLength(2);
    animations[1].finish();
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(animations).toHaveLength(3);
    });
    expect(complete).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement
        .querySelector('.composer')
        .classList.contains('refined-ready'),
    ).toBe(true);
    animations[2].finish();
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(complete).toHaveBeenCalledOnce();
    });
    await completion;
    expect(
      fixture.nativeElement
        .querySelector('.composer')
        .classList.contains('dissolved'),
    ).toBe(true);
  });

  it('aborts a pending transition and never starts dissolution or reports completion', async () => {
    const { controller, completion } = await begin();
    const result = completion.catch((error) => error.name);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(animations).toHaveLength(2);
    });
    controller.abort();
    expect(await result).toBe('AbortError');
    expect(animations).toHaveLength(2);
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
  });

  it('waits for actual visibility and cancels if cleared before the emblem settles', async () => {
    fixture.componentRef.setInput('visible', false);
    await fixture.whenStable();
    const { controller, completion } = await begin();
    const result = completion.catch((error) => error.name);
    await fixture.whenStable();
    expect(animations).toHaveLength(0);
    controller.abort();
    expect(await result).toBe('AbortError');
  });

  it('renders reduced-motion finalization without creating animations', async () => {
    const { completion } = await begin(true);
    let done = false;
    void completion.then(() => {
      done = true;
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(done).toBe(true);
    });
    await completion;
    expect(animations).toHaveLength(0);
  });

  it('retains the refined text after a failed or interrupted presentation', async () => {
    const { controller, completion } = await begin();
    const result = completion.catch((error) => error.name);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(animations).toHaveLength(2);
    });
    controller.abort();
    await result;
    fixture.componentRef.setInput('status', 'error');
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('.refined-text').textContent,
    ).toBe('Cleaned words');
    expect(fixture.componentInstance.showRefined()).toBe(true);
    expect(
      fixture.nativeElement
        .querySelector('.composer')
        .classList.contains('dissolved'),
    ).toBe(false);
  });

  it('shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
  });
});
