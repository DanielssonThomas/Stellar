import { expect, test } from '@playwright/test';

test('actual scene precesses in idle, assembles frontward and rebases interrupted return', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  const scene = page.locator('.camera');
  const ring = page.locator('.spin-clockwise');
  await expect(page.locator('.plane img')).toHaveCount(12);
  await expect
    .poll(() =>
      page
        .locator('.plane img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth === 1280,
          ),
        ),
    )
    .toBe(true);
  await expect
    .poll(() => scene.evaluate((element) => element.clientWidth))
    .toBe(480);
  const camera = await scene.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  const initialRing = await ring.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await expect
    .poll(() => ring.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(initialRing);
  expect(
    await ring.evaluate((element) =>
      element
        .getAnimations()
        .some(
          (animation) => animation.effect?.getTiming().iterations === Infinity,
        ),
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await expect
    .poll(() =>
      scene.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(camera);
  await expect
    .poll(() => ring.evaluate((element) => element.getAnimations().length))
    .toBe(0);
  await expect
    .poll(() =>
      page
        .locator('.plane')
        .evaluateAll((planes) =>
          planes.every(
            (plane) =>
              new DOMMatrix(getComputedStyle(plane).transform).isIdentity,
          ),
        ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await page.getByRole('button', { name: 'End activity', exact: true }).click();
  await expect(page.locator('[data-instance-id]')).toHaveCount(0);
  await expect(
    page.locator('stellar-desktop-experience-template'),
  ).toHaveAttribute('data-phase', 'idle');
  await expect
    .poll(() =>
      scene.evaluate((element) => getComputedStyle(element).transform),
    )
    .toBe(camera);
  await expect(page.locator('[data-instance-id]')).toHaveCount(0);
});

test('reduced motion keeps depth static and viewport fitting survives resize', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  const scene = page.locator('.camera');
  for (const viewport of [
    { width: 1100, height: 760 },
    { width: 480, height: 360 },
    { width: 800, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        scene.evaluate(
          (element) => element.getAnimations({ subtree: true }).length,
        ),
      )
      .toBe(0);
    await expect
      .poll(() =>
        page
          .locator('.plane')
          .first()
          .evaluate(
            (element) => new DOMMatrix(getComputedStyle(element).transform).m43,
          ),
      )
      .toBeLessThan(-20);
    expect(
      await page
        .locator('body')
        .evaluate((element) => element.scrollWidth <= innerWidth),
    ).toBe(true);
    await page
      .getByRole('button', { name: 'Start activity', exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator('.plane')
          .evaluateAll((planes) =>
            planes.every(
              (plane) =>
                new DOMMatrix(getComputedStyle(plane).transform).isIdentity,
            ),
          ),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  }
});
