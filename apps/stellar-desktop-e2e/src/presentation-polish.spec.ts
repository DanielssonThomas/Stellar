import { expect, test, type Page } from '@playwright/test';
import { openPane } from './stage-driver';

const recognize = (page: Page, text: string) =>
  page.evaluate((text) => {
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Missing root');
    const app = (
      window as unknown as {
        ng: {
          getComponent(element: Element): {
            voice: { current: { update(fn: (state: object) => object): void } };
          };
        };
      }
    ).ng.getComponent(root);
    app.voice.current.update((state) => ({ ...state, inputText: text }));
  }, text);

for (const width of [1600, 640]) {
  test(`presentation insets and opt-in pane controls at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    expect(
      await openPane(
        page,
        1,
        'marcus',
        'Marcus Aurelius',
        'Give thyself time to learn something new and good.',
        'primary',
      ),
    ).toBe('applied');
    const first = page.locator('[data-instance-id="marcus"]');
    await expect(first).toHaveCSS('padding-top', '16px');
    expect(
      await openPane(
        page,
        2,
        'epictetus',
        'Epictetus',
        'Some things are in our control and others not.',
      ),
    ).toBe('applied');
    const second = page.locator('[data-instance-id="epictetus"]');
    for (const pane of [first, second]) {
      await expect(pane).toHaveCSS('padding-top', '16px');
      await pane.hover();
      await pane.locator('.surface-content').focus();
      await expect(pane.locator('.pane-controls')).toHaveCount(0);
    }
    const insets = await page.locator('.surface').evaluateAll((panes) =>
      panes.map((pane) => {
        const style = getComputedStyle(pane);
        return [style.paddingTop, style.paddingLeft];
      }),
    );
    expect(insets[0]).toEqual(insets[1]);
    await page.keyboard.press('m');
    const toggle = page.getByLabel('Show pane controls', { exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.keyboard.press('Escape');
    await expect(
      first.getByRole('button', { name: 'Maximize pane', exact: true }),
    ).toBeVisible();
    await first
      .getByRole('button', { name: 'Maximize pane', exact: true })
      .click();
    await expect(second).toBeHidden();
    await first
      .getByRole('button', { name: 'Restore layout', exact: true })
      .click();
    await expect(second).toBeVisible();
    await page.keyboard.press('m');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.keyboard.press('Escape');
    await expect(page.locator('.pane-controls')).toHaveCount(0);
    await expect(first).toHaveCSS('padding-top', '16px');
    await recognize(page, 'Show two stoic quotes side by side.');
    await expect(
      page.getByRole('status').filter({ hasText: 'Show two stoic' }),
    ).toHaveText('Show two stoic quotes side by side.');
    await page.screenshot({
      path: testInfo.outputPath(`presentation-${width}.png`),
    });
  });
}

test('speech text updates in gold and respects system and app reduced motion', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.evaluate(() => {
    const durations: number[] = [];
    Object.assign(window, { __speechRevealDurations: durations });
    document.addEventListener('animationstart', (event) => {
      if (event.animationName.endsWith('transcript-arrive'))
        durations.push(
          event.target instanceof Element
            ? parseFloat(getComputedStyle(event.target).animationDuration) *
                1000
            : 0,
        );
    });
  });
  await recognize(page, 'Ivy, show two stoic quotes side by side.');
  const overlay = page.locator('stellar-voice-transcript-molecule');
  const status = overlay.getByRole('status');
  await expect(status).toHaveText('Ivy, show two stoic quotes side by side.');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await status.evaluate((element) => {
    element.dataset['retained'] = 'yes';
  });
  const durations = () =>
    page.evaluate(
      () =>
        (window as unknown as { __speechRevealDurations: number[] })
          .__speechRevealDurations,
    );
  await expect.poll(durations).toEqual([360]);
  await recognize(page, 'Show two stoic quotes side by side.');
  await expect(status).toHaveText('Show two stoic quotes side by side.');
  await expect.poll(durations).toEqual([360, 360]);
  await overlay.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((entry) => entry.finished),
    );
  });
  await page.screenshot({ path: testInfo.outputPath('speech-gold.png') });
  const words = 'Keep <script>literal</script> words intact.\n'.repeat(30);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await recognize(page, words);
  await expect(status).toHaveText(words);
  await expect(status).toHaveAttribute('data-retained', 'yes');
  await expect(overlay.locator('script')).toHaveCount(0);
  await expect(overlay.locator('.transcript-text')).toHaveCSS(
    'animation-name',
    'none',
  );
  expect(
    await status.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('m');
  await page.getByLabel('Reduce motion', { exact: true }).check();
  await page.keyboard.press('Escape');
  await recognize(page, 'A final complete transcript.');
  await expect(overlay).toHaveClass(/motion-reduced/);
  await expect(status).toHaveText('A final complete transcript.');
  await expect(overlay.locator('.transcript-text')).toHaveCSS(
    'animation-name',
    'none',
  );
});
