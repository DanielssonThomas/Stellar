import { expect, test } from '@playwright/test';

test('body fragments contain only small portions of the visible avatar silhouette', async ({
  page,
}) => {
  await page.goto('/');
  const manifest = await (
    await page.request.get('/emblem/manifest.json')
  ).json();
  const sizes = await page.evaluate(async (manifest) => {
    const result = [];
    for (const color of ['gold', 'violet']) {
      const image = new Image();
      image.src = `/emblem/layers/${color}-body.png`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1280;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is unavailable');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, 1280, 1280).data;
      const parts = manifest.layers.filter(
        (layer: { file: string }) => layer.file === `layers/${color}-body.png`,
      );
      const areas = parts.map((layer: { clip: number[] }) => {
        const [left, top, width, height] = layer.clip;
        let visible = 0;
        for (let y = top; y < top + height; y++)
          for (let x = left; x < left + width; x++)
            if (pixels[(y * 1280 + x) * 4 + 3] >= 24) visible++;
        return visible;
      });
      result.push({
        count: parts.length,
        smallest: Math.min(...areas),
        largest:
          Math.max(...areas) / areas.reduce((a: number, b: number) => a + b, 0),
      });
    }
    return result;
  }, manifest);
  for (const size of sizes) {
    expect(size.count).toBe(11);
    expect(size.smallest).toBeGreaterThan(32);
    expect(size.largest).toBeLessThan(0.22);
  }
});

test('outer fragment centers taper inward while the five rings remain coaxial', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const manifest = await (
    await page.request.get('/emblem/manifest.json')
  ).json();
  await expect(page.locator('.plane')).toHaveCount(73);
  await expect
    .poll(() =>
      page.locator('.camera').evaluate((element) => element.clientWidth),
    )
    .toBe(480);
  const measured = await page.locator('.plane').evaluateAll(
    (planes, layers) =>
      planes.flatMap((element, index) => {
        const layer = layers[index];
        if (!layer.centroid || Math.abs(layer.planeIndex - 36) < 27) return [];
        const width = (element as HTMLElement).clientWidth;
        const ratio = width / 1280;
        const origin = getComputedStyle(element)
          .transformOrigin.split(' ')
          .map(parseFloat);
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        const dx = layer.centroid.x * ratio - origin[0];
        const dy = layer.centroid.y * ratio - origin[1];
        const x = origin[0] + matrix.m11 * dx + matrix.m21 * dy + matrix.m41;
        const y = origin[1] + matrix.m12 * dx + matrix.m22 * dy + matrix.m42;
        const angle = (layer.exploded.rotation * Math.PI) / 180;
        const rawX =
          origin[0] +
          Math.cos(angle) * dx -
          Math.sin(angle) * dy +
          layer.exploded.x * ratio;
        const rawY =
          origin[1] +
          Math.sin(angle) * dx +
          Math.cos(angle) * dy +
          layer.exploded.y * ratio;
        return [
          {
            focused: Math.hypot(x - width / 2, y - width / 2),
            original: Math.hypot(rawX - width / 2, rawY - width / 2),
          },
        ];
      }),
    manifest.layers,
  );
  expect(measured.length).toBeGreaterThan(10);
  for (const point of measured)
    expect(point.focused).toBeLessThan(point.original * 0.75);
});

test('purple hair stays in front of every body fragment before settlement', async ({
  page,
}) => {
  await page.goto('/');
  const menu = page.getByRole('button', {
    name: 'Experience menu',
    exact: true,
  });
  await menu.click();
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  const scene = page.locator('.camera');
  await expect
    .poll(() => scene.evaluate((element) => element.getAnimations().length))
    .toBe(1);
  const ordering = await scene.evaluate((element) => {
    const animations = element.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 900;
    }
    const planes = Array.from(element.querySelectorAll<HTMLElement>('.plane'));
    const hairs = planes.filter((plane) =>
      /\/violet-hair-\d+\.png$/.test(plane.querySelector('img')?.src ?? ''),
    );
    const bodies = planes.filter((plane) =>
      plane.querySelector('img')?.src.endsWith('/violet-body.png'),
    );
    if (hairs.length !== 12 || bodies.length !== 11)
      throw Error('Missing purple artwork planes');
    const depth = (plane: HTMLElement) =>
      new DOMMatrix(getComputedStyle(plane).transform).m43;
    const result = { hairs: hairs.map(depth), bodies: bodies.map(depth) };
    for (const animation of animations) animation.play();
    return result;
  });
  for (const hair of ordering.hairs) {
    expect(hair).toBeLessThan(0);
    for (const body of ordering.bodies) expect(hair).toBeGreaterThan(body);
  }
  await menu.click();
});

test('settled face assembly is pixel-identical to the original unclipped image stack at supported sizes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const menu = page.getByRole('button', {
    name: 'Experience menu',
    exact: true,
  });
  for (const viewport of [
    { width: 1100, height: 760 },
    { width: 480, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await menu.click();
    await page
      .getByRole('button', { name: 'Start activity', exact: true })
      .click();
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(
      page.locator('stellar-desktop-experience-template'),
    ).toHaveAttribute('data-phase', 'listening');
    const camera = page.locator('.camera:not([data-original-baseline])');
    await expect
      .poll(() =>
        camera.evaluate((element) => {
          const matrix = new DOMMatrix(getComputedStyle(element).transform);
          if (!Number.isFinite(matrix.m34) || matrix.m34 >= 0) return false;
          // Perspective remains active in the front view; rotation, scale and translation must be identity.
          matrix.m34 = 0;
          return matrix.isIdentity;
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        camera
          .locator('.plane')
          .evaluateAll(
            (planes) =>
              planes.length === 73 &&
              planes.every(
                (plane) =>
                  new DOMMatrix(getComputedStyle(plane).transform).isIdentity,
              ),
          ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        camera.locator('img').evaluateAll((images) => {
          const seen = new Set<string>();
          return (
            images.length === 73 &&
            images.every((image) => {
              const first = !seen.has((image as HTMLImageElement).src);
              seen.add((image as HTMLImageElement).src);
              return (
                getComputedStyle(image).clipPath ===
                (first ? 'none' : 'inset(100%)')
              );
            })
          );
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        camera.evaluate(
          (element) => element.getAnimations({ subtree: true }).length,
        ),
      )
      .toBe(0);
    await camera
      .locator('img')
      .evaluateAll((images) =>
        Promise.all(
          images.map((image) => (image as HTMLImageElement).decode()),
        ),
      );
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
    const baseline = page.locator('[data-original-baseline]');
    await baseline
      .locator('img')
      .evaluateAll((images) =>
        Promise.all(
          images.map((image) => (image as HTMLImageElement).decode()),
        ),
      );
    const original = await baseline.screenshot();
    expect(assembled.equals(original)).toBe(true);
    await camera.evaluate((element) => {
      element.parentElement
        ?.querySelector('[data-original-baseline]')
        ?.remove();
      (element as HTMLElement).style.visibility = '';
    });
    await menu.click();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await menu.click();
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
  await expect(page.locator('.plane img')).toHaveCount(73);
  const manifestResponse = await page.request.get('/emblem/manifest.json');
  const manifest = await manifestResponse.json();
  expect(
    manifest.layers
      .map((layer: { planeIndex: number }) => layer.planeIndex)
      .sort((a: number, b: number) => a - b),
  ).toEqual(Array.from({ length: 73 }, (_, index) => index));
  expect(manifest.spacingProfile).toBe('outer-dense');
  const mainRing = manifest.layers.find(
    (layer: { id: string }) => layer.id === 'outer-frame',
  );
  expect(mainRing.exploded).toEqual({ x: 0, y: 0, rotation: 0 });
  expect(mainRing.planeIndex).toBe(36);
  const scatteredRings = manifest.layers.filter(
    (layer: { id: string; exploded: { x: number } }) =>
      layer.id.startsWith('inner-circle') && layer.exploded.x !== 0,
  );
  expect(scatteredRings).toHaveLength(0);
  expect(
    manifest.layers
      .filter((layer: { spin?: string }) => layer.spin)
      .every(
        (layer: {
          exploded: { x: number; y: number; rotation: number };
          centroid?: unknown;
        }) =>
          layer.exploded.x === 0 &&
          layer.exploded.y === 0 &&
          layer.exploded.rotation === 0 &&
          layer.centroid === undefined,
      ),
  ).toBe(true);
  for (const color of ['gold', 'violet']) {
    const bodies = manifest.layers.filter(
      (layer: { file: string }) =>
        layer.file === 'layers/' + color + '-body.png',
    );
    expect(bodies.map((layer: { clip: number[] }) => layer.clip)).toEqual([
      [0, 0, 1280, 512],
      ...[512, 560, 608, 656, 704, 752, 800, 848, 896].map((top) => [
        0,
        top,
        1280,
        48,
      ]),
      [0, 944, 1280, 336],
    ]);
    const jewelry = manifest.layers.filter(
      (layer: { assembly?: { file: string } }) =>
        layer.assembly?.file === `layers/${color}-ornament.png`,
    );
    expect(jewelry).toHaveLength(color === 'gold' ? 15 : 7);
    expect(
      jewelry.every(
        (layer: { clip?: unknown; file: string }) =>
          layer.clip === undefined && /-ornament-\d+\.png$/.test(layer.file),
      ),
    ).toBe(true);
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
  expect(interval).toBeGreaterThan(4);
  const gaps = depths.slice(1).map((depth, index) => depth - depths[index]);
  for (let index = 1; index < 34; index++)
    expect(gaps[index]).toBeGreaterThan(gaps[index - 1]);
  expect(depths.slice(34, 39)).toEqual([-180, -90, 0, 90, 180]);
  expect(gaps[Math.floor(gaps.length / 2)]).toBeGreaterThan(interval * 3);
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
      scene.evaluate((element, original) => {
        const current = new DOMMatrix(
          getComputedStyle(element).transform,
        ).toFloat64Array();
        const expected = new DOMMatrix(original).toFloat64Array();
        return Math.max(
          ...current.map((value, index) => Math.abs(value - expected[index])),
        );
      }, camera),
    )
    .toBeLessThan(0.000001);
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
