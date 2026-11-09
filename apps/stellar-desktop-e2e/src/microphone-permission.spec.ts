import { expect, test } from '@playwright/test';

test('manual permission review preserves capture ownership and reflects native cancellation or saved choice', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() => {
    const fixture = {
      calls: [] as unknown[],
      capture: 0,
      finish: (outcome: string): void => {
        throw Error(`No pending review for ${outcome}`);
      },
    };
    Object.assign(window, {
      __microphoneReviewFixture: fixture,
      __TAURI__: {
        core: {
          invoke: async (command: string, args: unknown) => {
            if (command !== 'microphone_permission_review')
              throw Error('Unexpected fixture command');
            fixture.calls.push(args);
            return new Promise((resolve) => {
              fixture.finish = (outcome) => {
                resolve({ version: 1, outcome });
              };
            });
          },
        },
      },
    });
    navigator.mediaDevices.getUserMedia = async () => {
      fixture.capture++;
      throw Error('Capture is not part of permission review');
    };
  });
  await page.keyboard.press('m');
  await page.getByRole('button', { name: 'Microphone', exact: true }).click();
  const review = page.getByRole('button', {
    name: 'Review microphone access',
    exact: true,
  });
  const calls = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __microphoneReviewFixture: { calls: unknown[]; capture: number };
          }
        ).__microphoneReviewFixture,
    );
  expect((await calls()).calls).toEqual([]);
  await review.click();
  await expect(
    page.getByRole('button', { name: 'Reviewing access…' }),
  ).toBeDisabled();
  expect((await calls()).calls).toEqual([{ request: { version: 1 } }]);
  const finish = (outcome: string) =>
    page.evaluate(
      (outcome) =>
        (
          window as unknown as {
            __microphoneReviewFixture: { finish(outcome: string): void };
          }
        ).__microphoneReviewFixture.finish(outcome),
      outcome,
    );
  await finish('cancelled');
  await expect(
    page.getByText(
      'Permission review cancelled. Microphone access was not changed.',
    ),
  ).toBeVisible();
  await review.click();
  await finish('allowed');
  await expect(
    page.getByText(
      'Microphone permission saved. Enable the microphone when you are ready. Windows privacy settings still apply.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enable microphone', exact: true }),
  ).toBeVisible();
  expect((await calls()).capture).toBe(0);
  expect((await calls()).calls).toHaveLength(2);
});

test('browser preview reports unavailable review without claiming microphone access', async ({
  page,
}) => {
  await page.goto('/');
  await page.keyboard.press('m');
  await page.getByRole('button', { name: 'Microphone', exact: true }).click();
  await page
    .getByRole('button', { name: 'Review microphone access', exact: true })
    .click();
  await expect(
    page.getByText(
      'Permission review is unavailable in this version of the app. You can still use typed messages.',
    ),
  ).toBeVisible();
});
