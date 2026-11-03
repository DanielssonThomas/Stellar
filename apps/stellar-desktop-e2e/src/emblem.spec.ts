import { expect, test } from '@playwright/test';

test('prepares selected fragments and assembled sources before interaction and refreshes after resize', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.addInitScript(() => {
    const state = window as typeof window & { emblemDecodes: string[] };
    state.emblemDecodes = [];
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      return decode.call(this).then(() => {
        if (this.currentSrc.includes('/emblem/'))
          state.emblemDecodes.push(this.currentSrc);
      });
    };
  });
  await page.goto('/');
  const decoded = () =>
    page.evaluate(() => [
      ...new Set(
        (window as typeof window & { emblemDecodes: string[] }).emblemDecodes,
      ),
    ]);
  await expect.poll(async () => (await decoded()).length).toBe(91);
  const sources = await decoded();
  expect(
    sources.filter((url) => url.includes('/resolutions/512/')),
  ).toHaveLength(86);
  expect(
    sources.filter((url) =>
      /\/(gold|violet)-(body|hair|ornament)\.png$/.test(url),
    ),
  ).toHaveLength(6);
  await expect(
    page.locator('stellar-desktop-experience-template'),
  ).toHaveAttribute('data-phase', 'idle');
  const plane = page.locator('.plane').first();
  expect(
    await plane.evaluate((element) => getComputedStyle(element).willChange),
  ).toBe('transform');
  const animationIds = await page
    .locator('.artwork')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAnimations()[0]?.startTime),
    );
  await page.locator('stellar-emblem-motion-molecule').evaluate((element) => {
    (element as HTMLElement).style.width = '700px';
  });
  await expect
    .poll(
      async () =>
        (await decoded()).filter((url) => url.includes('/resolutions/768/'))
          .length,
    )
    .toBe(86);
  expect(
    await page
      .locator('.artwork')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAnimations()[0]?.startTime),
      ),
  ).toEqual(animationIds);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      plane.evaluate((element) => getComputedStyle(element).willChange),
    )
    .toBe('auto');
});

test('81 pieces retain individual idle floats and thirteen independent ring rotations', async ({
  page,
}) => {
  await page.goto('/');
  const camera = page.locator('.camera');
  await expect(page.locator('.plane')).toHaveCount(81);
  await expect
    .poll(() =>
      camera.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.effect?.getTiming().iterations === Infinity,
            ).length,
      ),
    )
    .toBe(81);
  await expect
    .poll(() =>
      page
        .locator('.artwork:not(.spin-clockwise):not(.spin-counter)')
        .evaluateAll((elements) =>
          elements.reduce(
            (count, element) => count + element.getAnimations().length,
            0,
          ),
        ),
    )
    .toBe(68);
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await expect
    .poll(() =>
      camera.evaluate(
        (element) => element.getAnimations({ subtree: true }).length,
      ),
    )
    .toBe(0);
  await expect(page.locator('.plane')).toHaveCount(81);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect
    .poll(() =>
      camera.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.effect?.getTiming().iterations === Infinity,
            ).length,
      ),
    )
    .toBe(81);
});

for (const [density, resolution, prefix] of [
  [1, 512, '/emblem/resolutions/512/layers/'],
  [2, 1024, '/emblem/resolutions/1024/layers/'],
  [3, 1280, '/emblem/layers/'],
] as const) {
  test(`cold emblem load selects ${resolution}px rasters at ${density}x density`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1100, height: 760 },
      deviceScaleFactor: density,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const pngRequests = new Set<string>();
      page.on('request', (request) => {
        if (
          request.resourceType() === 'image' &&
          request.url().endsWith('.png')
        )
          pngRequests.add(new URL(request.url()).pathname);
      });
      await page.goto('/');
      await expect(page.locator('.plane img')).toHaveCount(81);
      await expect
        .poll(() =>
          page
            .locator('.plane img')
            .evaluateAll((images) =>
              images.every(
                (image) =>
                  (image as HTMLImageElement).complete &&
                  (image as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
      const sources = await page
        .locator('.emblem-presence img')
        .evaluateAll((images) =>
          images.map((image) => ({
            source: (image as HTMLImageElement).currentSrc,
            sizes: (image as HTMLImageElement).sizes,
          })),
        );
      const rasters = sources.filter((image) => image.source.endsWith('.png'));
      expect(rasters).toHaveLength(86);
      expect(
        rasters.every(
          (image) => image.source.includes(prefix) && image.sizes === '480px',
        ),
      ).toBe(true);
      expect(pngRequests.size).toBe(86);
      expect([...pngRequests].every((url) => url.startsWith(prefix))).toBe(
        true,
      );
      const png = await page.request.get(rasters[0].source);
      expect((await png.body()).readUInt32BE(16)).toBe(resolution);
    } finally {
      await context.close();
    }
  });
}

test('resolution hints follow container and viewport resize without changing the 81-piece scene', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  const raster = page.locator('.plane img').first();
  await expect(raster).toHaveAttribute('sizes', '480px');
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await expect(page.locator('.plane')).toHaveCount(81);
  await expect.poll(() => raster.getAttribute('sizes')).toBe('320px');
  await page.locator('stellar-emblem-motion-molecule').evaluate((element) => {
    (element as HTMLElement).style.width = '96px';
  });
  await expect.poll(() => raster.getAttribute('sizes')).toBe('96px');
  await page.locator('stellar-emblem-motion-molecule').evaluate((element) => {
    (element as HTMLElement).style.width = '';
  });
  await expect.poll(() => raster.getAttribute('sizes')).toBe('320px');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect.poll(() => raster.getAttribute('sizes')).toBe('480px');
  await page.setViewportSize({ width: 360, height: 480 });
  await expect.poll(() => raster.getAttribute('sizes')).toBe('312px');
  await expect(page.locator('.plane')).toHaveCount(81);
});

test('all gold fragments stay on the gold side and all violet fragments stay on the violet side', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const manifest = await (
    await page.request.get('/emblem/manifest.json')
  ).json();
  const camera = page.locator('.camera');
  await expect(page.locator('.plane')).toHaveCount(81);
  await expect
    .poll(() => camera.evaluate((element) => element.clientWidth))
    .toBe(480);
  const fragments = await camera.evaluate((element, layers) => {
    const cameraStyle = getComputedStyle(element);
    const cameraOrigin = cameraStyle.transformOrigin.split(' ').map(parseFloat);
    const view = new DOMMatrix(cameraStyle.transform);
    return Array.from(element.querySelectorAll<HTMLElement>('.plane')).flatMap(
      (plane, index) => {
        const layer = layers[index];
        if (!layer.centroid || !/^layers\/(gold|violet)-/.test(layer.file))
          return [];
        const style = getComputedStyle(plane);
        const origin = style.transformOrigin.split(' ').map(parseFloat);
        const transform = new DOMMatrix(style.transform);
        const point = transform.transformPoint(
          new DOMPoint(
            (layer.centroid.x * plane.clientWidth) / 1280 - origin[0],
            (layer.centroid.y * plane.clientHeight) / 1280 - origin[1],
          ),
        );
        const projected = view.transformPoint(
          new DOMPoint(
            point.x + origin[0] - cameraOrigin[0],
            point.y + origin[1] - cameraOrigin[1],
            point.z,
          ),
        );
        return [
          {
            id: layer.id,
            gold: layer.file.startsWith('layers/gold-'),
            depth: transform.m43,
            x: projected.x / projected.w,
          },
        ];
      },
    );
  }, manifest.layers);
  expect(fragments).toHaveLength(68);
  const gold = fragments.filter((fragment) => fragment.gold);
  const violet = fragments.filter((fragment) => !fragment.gold);
  expect(gold).toHaveLength(38);
  expect(violet).toHaveLength(30);
  for (const fragment of gold) {
    expect(fragment.depth, fragment.id).toBeGreaterThan(0);
    expect(fragment.x, fragment.id).toBeLessThan(0);
  }
  for (const fragment of violet) {
    expect(fragment.depth, fragment.id).toBeLessThan(0);
    expect(fragment.x, fragment.id).toBeGreaterThan(0);
  }
});

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
        (layer: { assembly?: { file: string } }) =>
          layer.assembly?.file === `layers/${color}-body.png`,
      );
      let longestHorizontalCut = 0;
      const areas = await Promise.all(
        parts.map(async (layer: { file: string }) => {
          const fragment = new Image();
          fragment.src = '/emblem/' + layer.file;
          await fragment.decode();
          ctx.clearRect(0, 0, 1280, 1280);
          ctx.drawImage(fragment, 0, 0);
          const fragmentPixels = ctx.getImageData(0, 0, 1280, 1280).data;
          let visible = 0;
          for (let y = 0; y < 1280; y++) {
            let horizontalCut = 0;
            for (let x = 0; x < 1280; x++) {
              const p = (y * 1280 + x) * 4 + 3;
              if (fragmentPixels[p] >= 24) visible++;
              const cut =
                y > 0 &&
                pixels[p] >= 24 &&
                pixels[p - 5120] >= 24 &&
                fragmentPixels[p] >= 24 !== fragmentPixels[p - 5120] >= 24;
              horizontalCut = cut ? horizontalCut + 1 : 0;
              longestHorizontalCut = Math.max(
                longestHorizontalCut,
                horizontalCut,
              );
            }
          }
          return visible;
        }),
      );
      result.push({
        count: parts.length,
        smallest: Math.min(...areas),
        largest:
          Math.max(...areas) / areas.reduce((a: number, b: number) => a + b, 0),
        longestHorizontalCut,
      });
    }
    return result;
  }, manifest);
  for (const size of sizes) {
    expect(size.count).toBe(11);
    expect(size.smallest).toBeGreaterThan(32);
    expect(size.largest).toBeLessThan(0.22);
    expect(size.longestHorizontalCut).toBeLessThan(64);
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
  await expect(page.locator('.plane')).toHaveCount(81);
  await expect
    .poll(() =>
      page.locator('.camera').evaluate((element) => element.clientWidth),
    )
    .toBe(480);
  const measured = await page.locator('.plane').evaluateAll(
    (planes, layers) =>
      planes.flatMap((element, index) => {
        const layer = layers[index];
        if (!layer.centroid || Math.abs(layer.planeIndex - 40) < 31) return [];
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
      /\/violet-body-\d+\.png$/.test(plane.querySelector('img')?.src ?? ''),
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
              planes.length === 81 &&
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
            images.length === 81 &&
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
  await expect(page.locator('.plane img')).toHaveCount(81);
  const manifestResponse = await page.request.get('/emblem/manifest.json');
  const manifest = await manifestResponse.json();
  expect(
    manifest.layers
      .map((layer: { planeIndex: number }) => layer.planeIndex)
      .sort((a: number, b: number) => a - b),
  ).toEqual(Array.from({ length: 81 }, (_, index) => index));
  expect(manifest.spacingProfile).toBe('outer-dense');
  const mainRing = manifest.layers.find(
    (layer: { id: string }) => layer.id === 'outer-frame',
  );
  expect(mainRing.exploded).toEqual({ x: 0, y: 0, rotation: 0 });
  expect(mainRing.planeIndex).toBe(40);
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
      (layer: { assembly?: { file: string } }) =>
        layer.assembly?.file === 'layers/' + color + '-body.png',
    );
    expect(bodies).toHaveLength(11);
    expect(
      bodies.every(
        (layer: { clip?: unknown; file: string }) =>
          layer.clip === undefined && /-body-\d+\.png$/.test(layer.file),
      ),
    ).toBe(true);
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
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      scene.evaluate((element) => parseFloat(getComputedStyle(element).width)),
    )
    .toBe(480);
  await expect
    .poll(() =>
      page
        .locator('.plane')
        .evaluateAll((planes) =>
          planes.every((plane) => plane.getAnimations().length === 0),
        ),
    )
    .toBe(true);
  const planeDepths = await page
    .locator('.plane')
    .evaluateAll((planes) =>
      planes.map(
        (plane) => new DOMMatrix(getComputedStyle(plane).transform).m43,
      ),
    );
  const depths = planeDepths
    .filter((_, index) =>
      manifest.layers[index].file.startsWith('layers/violet-'),
    )
    .sort((a, b) => a - b);
  const interval = depths[1] - depths[0];
  expect(interval).toBeGreaterThan(4);
  const gaps = depths.slice(1).map((depth, index) => depth - depths[index]);
  const violetPlanes = manifest.layers
    .map((layer: { planeIndex: number; file: string }, index: number) => ({
      ...layer,
      depth: planeDepths[index],
    }))
    .filter((layer: { file: string }) =>
      layer.file.startsWith('layers/violet-'),
    )
    .sort(
      (a: { planeIndex: number }, b: { planeIndex: number }) =>
        a.planeIndex - b.planeIndex,
    );
  const intervals = violetPlanes
    .slice(1)
    .map((current: { planeIndex: number; depth: number }, index: number) => ({
      stride: current.planeIndex - violetPlanes[index].planeIndex,
      gap: current.depth - violetPlanes[index].depth,
    }));
  const adjacent = intervals
    .slice(1)
    .map((current: { stride: number; gap: number }, index: number) => ({
      current,
      previous: intervals[index],
    }))
    .filter(
      ({
        current,
        previous,
      }: {
        current: { stride: number };
        previous: { stride: number };
      }) => current.stride === 1 && previous.stride === 1,
    );
  for (const { current, previous } of adjacent)
    expect(current.gap).toBeGreaterThan(previous.gap);
  const ringDepths = planeDepths
    .filter((_, index) => manifest.layers[index].spin)
    .sort((a, b) => a - b);
  expect(ringDepths).toEqual(
    [-570, -480, -410, -330, -240, -170, 0, 150, 240, 330, 390, 480, 570].map(
      (depth) => depth * 0.375,
    ),
  );
  const arcs = manifest.layers.filter(
    (layer: { assembly?: { file: string } }) =>
      layer.assembly?.file.endsWith('.svg'),
  );
  expect(arcs).toHaveLength(12);
  for (const file of new Set(
    arcs.map((layer: { assembly: { file: string } }) => layer.assembly.file),
  ))
    expect(
      arcs.filter(
        (layer: { assembly: { file: string } }) => layer.assembly.file === file,
      ),
    ).toHaveLength(3);
  expect(gaps.at(-1)).toBeGreaterThan(interval * 3);
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
