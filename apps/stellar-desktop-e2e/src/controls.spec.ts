import { expect, test } from '@playwright/test';

test('M opens modal controls, contains focus, preserves typing and switches to music', async ({
  page,
}) => {
  await page.goto('/');
  const desktop = page.locator('stellar-desktop-experience-template');
  const controls = page.getByRole('dialog', {
    name: 'Experience controls',
    exact: true,
  });
  const music = page.getByRole('dialog', {
    name: 'Music visualizer',
    exact: true,
  });
  await expect(
    page.getByRole('button', { name: 'Experience menu', exact: true }),
  ).toHaveCount(0);
  await expect(controls).toBeHidden();
  await desktop.focus();
  await page.keyboard.press('Control+m');
  await page.keyboard.press('Alt+m');
  await expect(controls).toBeHidden();
  await page.keyboard.press('Shift+M');
  await expect(controls).toBeVisible();
  await expect(page.locator('dialog:modal')).toHaveCount(1);
  const close = controls.getByRole('button', {
    name: 'Close experience controls',
    exact: true,
  });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    controls.getByRole('switch', { name: 'Ivy awareness', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  const draft = controls.getByRole('textbox', {
    name: 'Message Ivy',
    exact: true,
  });
  await draft.focus();
  await page.keyboard.type('mp');
  await expect(draft).toHaveValue('mp');
  await expect(controls).toBeVisible();
  await expect(music).toBeHidden();
  await controls
    .getByRole('button', { name: 'Music visualizer · P', exact: true })
    .click();
  await expect(controls).toBeHidden();
  await expect(music).toBeVisible();
  await page.keyboard.press('m');
  await expect(music).toBeHidden();
  await expect(controls).toBeVisible();
  await expect(draft).toHaveValue('mp');
  await page.keyboard.press('p');
  await expect(controls).toBeHidden();
  await expect(music).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(music).toBeHidden();
  await page.keyboard.press('m');
  await close.click();
  await expect(controls).toBeHidden();
  await expect(desktop).toBeFocused();
});

test('Escape closes controls without dismissing manual activity', async ({
  page,
}) => {
  await page.goto('/');
  const desktop = page.locator('stellar-desktop-experience-template');
  const controls = page.getByRole('dialog', { name: 'Experience controls' });
  await page.keyboard.press('m');
  await controls
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await expect(desktop).toHaveAttribute('data-phase', 'listening');
  await page.keyboard.press('Escape');
  await expect(controls).toBeHidden();
  await expect(desktop).toHaveAttribute('data-phase', 'listening');
  await expect(desktop).toBeFocused();
  await page.keyboard.press('m');
  await controls
    .getByRole('button', { name: 'End activity', exact: true })
    .click();
  await expect(desktop).toHaveAttribute('data-phase', 'idle');
});

test('controls fit a small window and scroll to the last setting', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await page.goto('/');
  await page.keyboard.press('m');
  const controls = page.getByRole('dialog', { name: 'Experience controls' });
  await expect(controls).toBeVisible();
  const box = await controls.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(15);
  expect(box?.y).toBeGreaterThanOrEqual(15);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(345);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(465);
  expect(
    await controls.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('controls-narrow.png') });
  await controls.getByLabel('Reduce motion').check();
  await expect(controls.getByLabel('Reduce motion')).toBeChecked();
  await controls
    .getByRole('button', { name: 'Close experience controls' })
    .click();
  await expect(controls).toBeHidden();
});
