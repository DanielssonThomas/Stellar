import { expect, test } from '@playwright/test';
import { controlPane, openPane } from './stage-driver';

test('focus during repeated and interrupted pane changes never scrolls the workspace', async ({
  page,
}) => {
  const advanceFrames = (count: number) =>
    page.evaluate(async (count) => {
      for (let frame = 0; frame < count; frame++)
        await new Promise(requestAnimationFrame);
    }, count);
  await page.goto('/');
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.evaluate(() => {
    const state = window as unknown as {
      workspaceFrames: {
        x: number;
        y: number;
        width: number;
        height: number;
        scroll: number[];
      }[];
      recordWorkspace: boolean;
    };
    state.workspaceFrames = [];
    state.recordWorkspace = true;
    const sample = () => {
      const host = document.querySelector('stellar-stage-organism');
      const experience = document.querySelector('.experience');
      if (host && experience) {
        const { x, y, width, height } = host.getBoundingClientRect();
        state.workspaceFrames.push({
          x,
          y,
          width,
          height,
          scroll: [experience.scrollLeft, experience.scrollTop],
        });
      }
      if (state.recordWorkspace) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await openPane(page, 1, 'plan', 'Plan', 'Stable primary content', 'primary');
  const plan = page.locator('[data-instance-id="plan"]');
  await plan.evaluate((element) => {
    (element as HTMLElement).dataset['preserved'] = 'yes';
  });
  let commandId = 2;
  for (let round = 0; round < 3; round++) {
    for (const id of ['second', 'third', 'fourth']) {
      await openPane(page, commandId++, id, id, 'Long content\n'.repeat(40));
      await advanceFrames(round === 0 ? 32 : 5);
    }
    for (const id of ['fourth', 'third', 'second']) {
      await controlPane(page, 'close', id);
      await advanceFrames(round === 0 ? 32 : 5);
    }
  }
  await expect(plan).toHaveCSS('width', '1100px');
  const frames = await page.evaluate(() => {
    const state = window as unknown as {
      recordWorkspace: boolean;
      workspaceFrames: {
        x: number;
        y: number;
        width: number;
        height: number;
        scroll: number[];
      }[];
    };
    state.recordWorkspace = false;
    return state.workspaceFrames;
  });
  expect(frames.length).toBeGreaterThan(30);
  for (const frame of frames) {
    expect(frame.x).toBe(0);
    expect(frame.y).toBe(0);
    expect(frame.width).toBe(1100);
    expect(frame.height).toBe(760);
    expect(frame.scroll).toEqual([0, 0]);
  }
  await expect(plan).toHaveAttribute('data-preserved', 'yes');
  await expect(plan).toHaveCSS('width', '1100px');
});

test('workspace tiles fill the viewport and stable content survives pane insertion and retirement', async ({
  page,
}) => {
  await page.goto('/');
  await page.setViewportSize({ width: 1600, height: 1000 });
  expect(
    await openPane(
      page,
      1,
      'plan',
      'Stellar Desktop — Implementation Plan',
      'A focused workspace for Ivy.\n\nRequirements remain visible across structural changes.',
      'primary',
    ),
  ).toBe('applied');
  const plan = page.locator('[data-instance-id="plan"]');
  await expect(plan).toHaveCSS('width', '1600px');
  await plan.evaluate((element) => {
    (element as HTMLElement).dataset['preserved'] = 'yes';
  });
  await openPane(
    page,
    2,
    'support',
    'Supporting reference',
    'Selected content is presented here.',
  );
  await expect(plan).toHaveCSS('width', '864px');
  await openPane(
    page,
    3,
    'workflow',
    'Stellar Workflow',
    'Source: browser test fixture\nNo production status is represented.',
  );
  await expect(page.locator('[data-instance-id="workflow"]')).toHaveCSS(
    'top',
    '500px',
  );
  expect(
    await page.locator('[data-instance-id]').evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          id: (element as HTMLElement).dataset['instanceId'],
          x: parseFloat(style.left),
          y: parseFloat(style.top),
          width: parseFloat(style.width),
          height: parseFloat(style.height),
          radius: style.borderRadius,
          shadow: style.boxShadow,
          borderLeft: style.borderLeftWidth,
          borderTop: style.borderTopWidth,
        };
      }),
    ),
  ).toEqual([
    {
      id: 'plan',
      x: 0,
      y: 0,
      width: 864,
      height: 1000,
      radius: '0px',
      shadow: 'none',
      borderLeft: '0px',
      borderTop: '0px',
    },
    {
      id: 'support',
      x: 864,
      y: 0,
      width: 736,
      height: 500,
      radius: '0px',
      shadow: 'none',
      borderLeft: '1px',
      borderTop: '0px',
    },
    {
      id: 'workflow',
      x: 864,
      y: 500,
      width: 736,
      height: 500,
      radius: '0px',
      shadow: 'none',
      borderLeft: '1px',
      borderTop: '1px',
    },
  ]);
  await expect(plan).toHaveAttribute('data-preserved', 'yes');
  const contentBounds = await page
    .locator('[data-instance-id="workflow"] .surface-content')
    .boundingBox();
  const emblemBounds = await page.locator('.emblem-slot').boundingBox();
  expect(
    contentBounds &&
      emblemBounds &&
      contentBounds.y + contentBounds.height < emblemBounds.y,
  ).toBe(true);
  await expect(
    page.getByRole('button', { name: /^(Close|Minimize) Assistant message$/ }),
  ).toHaveCount(0);
  await controlPane(page, 'close', 'workflow');
  await expect(page.locator('[data-instance-id="workflow"]')).toHaveCount(0);
  await expect(page.locator('[data-instance-id="support"]')).toHaveCSS(
    'height',
    '1000px',
  );
  await expect(plan).toHaveAttribute('data-preserved', 'yes');
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(plan).toHaveCSS('width', '640px');
  await expect(plan).toHaveCSS('height', '400px');
});

test('shared edges move together through actual animation frames', async ({
  page,
}) => {
  await page.goto('/');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openPane(page, 1, 'plan', 'Plan', 'Stable primary content', 'primary');
  await expect(page.locator('[data-instance-id="plan"]')).toHaveCSS(
    'opacity',
    '1',
  );
  await openPane(page, 2, 'support', 'Reference', 'New supporting content');
  const frames = await page.evaluate(async () => {
    const frames: { right: number; left: number; width: number }[] = [];
    for (let i = 0; i < 25; i++) {
      await new Promise(requestAnimationFrame);
      const a = document
        .querySelector('[data-instance-id="plan"]')
        ?.getBoundingClientRect();
      const b = document
        .querySelector('[data-instance-id="support"]')
        ?.getBoundingClientRect();
      if (a && b) frames.push({ right: a.right, left: b.left, width: b.width });
    }
    return frames;
  });
  expect(frames.some((frame) => frame.width > 1 && frame.width < 735)).toBe(
    true,
  );
  for (const frame of frames)
    expect(Math.abs(frame.right - frame.left)).toBeLessThan(1);
  await controlPane(page, 'close', 'support');
  await expect(page.locator('[data-instance-id="support"]')).toHaveCount(0);
  await expect(page.locator('[data-instance-id="plan"]')).toHaveCSS(
    'width',
    '1600px',
  );
});
