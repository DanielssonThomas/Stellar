import { expect, test } from '@playwright/test';

test('settled face assembly is pixel-identical to the original unclipped image stack at supported sizes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  for (const viewport of [
    { width: 1100, height: 760 },
    { width: 480, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await page
      .getByRole('button', { name: 'Start activity', exact: true })
      .click();
    const camera = page.locator('.camera:not([data-original-baseline])');
    await expect
      .poll(() =>
        camera.evaluate(
          (element) => element.getAnimations({ subtree: true }).length,
        ),
      )
      .toBe(0);
    await expect
      .poll(() =>
        camera
          .locator('img')
          .evaluateAll((images) =>
            images.every((image) => (image as HTMLImageElement).complete),
          ),
      )
      .toBe(true);
    const assembled = await camera.screenshot();
    await camera.evaluate((element) => {
      const original = element.cloneNode(true) as HTMLElement;
      original.dataset['originalBaseline'] = 'true';
      const files = new Set<string>();
      for (const plane of original.querySelectorAll<HTMLElement>('.plane')) {
        const image = plane.querySelector('img');
        if (!image) throw new Error('Missing original image');
        if (files.has(image.src)) plane.remove();
        else {
          files.add(image.src);
          image.style.clipPath = 'none';
        }
      }
      element.after(original);
      (element as HTMLElement).style.visibility = 'hidden';
    });
    const original = await page
      .locator('[data-original-baseline]')
      .screenshot();
    expect(assembled.equals(original)).toBe(true);
    await camera.evaluate((element) => {
      element.parentElement
        ?.querySelector('[data-original-baseline]')
        ?.remove();
      (element as HTMLElement).style.visibility = '';
    });
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  }
});

test('actual scene rotates in idle, assembles frontward and rebases interrupted return', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  const scene = page.locator('.camera');
  const ring = page.locator('.spin-clockwise');
  await expect(page.locator('.plane img')).toHaveCount(15);
  const manifestResponse = await page.request.get('/emblem/manifest.json');
  const manifest = await manifestResponse.json();
  expect(
    manifest.layers
      .map((layer: { planeIndex: number }) => layer.planeIndex)
      .sort((a: number, b: number) => a - b),
  ).toEqual(Array.from({ length: 15 }, (_, index) => index));
  for (const color of ['gold', 'violet']) {
    const bodies = manifest.layers.filter(
      (layer: { file: string }) =>
        layer.file === 'layers/' + color + '-body.png',
    );
    expect(bodies.map((layer: { clip: number[] }) => layer.clip)).toEqual([
      [0, 0, 1280, 512],
      [0, 512, 1280, 128],
      [0, 640, 1280, 640],
    ]);
  }
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
  const depths = await page
    .locator('.plane')
    .evaluateAll((planes) =>
      planes
        .map((plane) => new DOMMatrix(getComputedStyle(plane).transform).m43)
        .sort((a, b) => a - b),
    );
  const interval = depths[1] - depths[0];
  expect(interval).toBeGreaterThan(70);
  depths
    .slice(1)
    .forEach((depth, index) =>
      expect(depth - depths[index]).toBeCloseTo(interval, 2),
    );
  expect(depths[0] + (depths.at(-1) ?? 0)).toBeCloseTo(0, 2);
  const outer = await page.request.get('/emblem/layers/outer-frame.svg');
  expect((await outer.text()).match(/<g transform="translate\(/g)).toHaveLength(
    4,
  );
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
    await ring.evaluate(
      (element) => new DOMMatrix(getComputedStyle(element).transform).is2D,
    ),
  ).toBe(true);
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
      scene.evaluate(
        (element) => element.getAnimations()[0]?.effect?.getTiming().duration,
      ),
    )
    .toBe(1000);
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
