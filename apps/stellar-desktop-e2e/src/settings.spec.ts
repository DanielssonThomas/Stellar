import { expect, test } from '@playwright/test';

test('arrow navigation follows keyboard focus after tabbing and during section scrolling', async ({
  page,
}) => {
  await page.goto('/');
  await page.keyboard.press('m');
  const navigation = page.getByRole('navigation', {
    name: 'Settings sections',
  });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(
    navigation.getByRole('button', { name: 'Ivy', exact: true }),
  ).toBeFocused();
  await expect(
    navigation.getByRole('button', { name: 'Overview', exact: true }),
  ).toHaveAttribute('aria-current', 'location');
  await page.keyboard.press('ArrowDown');
  await expect(
    navigation.getByRole('button', { name: 'App awareness', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(
    navigation.getByRole('button', { name: 'App awareness', exact: true }),
  ).toBeFocused();
});

test('section navigation keeps settings in a fixed gold frame and follows keyboard and scrolling', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', {
    name: 'Experience controls',
    exact: true,
  });
  const navigation = dialog.getByRole('navigation', {
    name: 'Settings sections',
  });
  const initial = await dialog.boundingBox();
  await expect(navigation.getByRole('button')).toHaveCount(4);
  await expect(
    navigation.getByRole('button', { name: 'Overview', exact: true }),
  ).toHaveAttribute('aria-current', 'location');
  await page.screenshot({
    path: testInfo.outputPath('settings-desktop-overview.png'),
  });
  await navigation
    .getByRole('button', { name: 'Microphone', exact: true })
    .click();
  const sensitivity = dialog.getByRole('switch', {
    name: 'Higher wake sensitivity',
  });
  await expect(sensitivity).toBeInViewport();
  await expect(
    dialog.getByRole('switch', { name: 'Show recognition results' }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('settings-desktop-microphone.png'),
  });
  await navigation.getByRole('button', { name: 'Ivy', exact: true }).focus();
  await page.keyboard.press('End');
  const awareness = dialog.getByRole('switch', {
    name: 'Ivy awareness',
    exact: true,
  });
  await expect(awareness).toBeInViewport();
  await expect(
    navigation.getByRole('button', { name: 'App awareness', exact: true }),
  ).toBeFocused();
  await expect(
    navigation.getByRole('button', { name: 'App awareness', exact: true }),
  ).toHaveAttribute('aria-current', 'location');
  const final = await dialog.boundingBox();
  expect(final?.height).toBe(initial?.height);
  expect(final?.width).toBe(initial?.width);
  await page.keyboard.press('Home');
  await expect(
    navigation.getByRole('button', { name: 'Overview', exact: true }),
  ).toBeFocused();
  const motion = dialog.getByRole('switch', {
    name: 'Reduce motion',
    exact: true,
  });
  await motion.focus();
  await page.keyboard.press('Space');
  await expect(motion).toBeChecked();
  await page.keyboard.press('s');
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('region', { name: 'Ivy status and request timeline' }),
  ).toBeVisible();
  await page.keyboard.press('m');
  await dialog.getByRole('switch', { name: 'Show pane controls' }).focus();
  await page.keyboard.press('m');
  await expect(dialog).toBeHidden();
});

test('compact settings keep every section reachable without horizontal scrolling', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await page.goto('/');
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', {
    name: 'Experience controls',
    exact: true,
  });
  const navigation = dialog.getByRole('navigation', {
    name: 'Settings sections',
  });
  for (const name of ['Overview', 'Microphone', 'Ivy', 'App awareness']) {
    await navigation.getByRole('button', { name, exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name, exact: true, level: 3 }),
    ).toBeInViewport();
    await expect(
      navigation.getByRole('button', { name, exact: true }),
    ).toHaveAttribute('aria-current', 'location');
    await expect
      .poll(() =>
        dialog
          .locator('[data-settings-scroll]')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(
        `settings-compact-${name.toLowerCase().replaceAll(' ', '-')}.png`,
      ),
    });
  }
  await expect(
    dialog.getByRole('switch', { name: 'Ivy awareness', exact: true }),
  ).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('stellar-desktop-experience-template'),
  ).toBeFocused();
});
