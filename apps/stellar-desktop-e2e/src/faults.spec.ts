import { expect, test } from '@playwright/test';
import type { IvySnapshot } from '@stellar/desktop-contracts';

type FaultFixture = { failConnect: boolean; calls: string[] };

async function install(
  page: import('@playwright/test').Page,
  uncertain = false,
) {
  await page.addInitScript((uncertain) => {
    const fixture: FaultFixture = { failConnect: false, calls: [] };
    const snapshot: IvySnapshot = {
      version: 1,
      revision: '1',
      turn_id: uncertain ? '11111111-2222-4333-8444-555555555555' : null,
      model: 'terra',
      verified_model: null,
      workspace_tools: 'unavailable',
      workspace_epoch: '0',
      reset_id: null,
      activity: [],
      connection: 'ready',
      turn: uncertain ? 'uncertain' : 'idle',
      items: [],
      error: null,
    };
    Object.assign(window, {
      __faultFixture: fixture,
      __TAURI__: {
        event: { listen: async () => () => undefined },
        core: {
          invoke: async (
            command: string,
            args: { request: Record<string, unknown> },
          ) => {
            fixture.calls.push(command);
            if (command === 'app_info')
              return {
                version: 1,
                sequence: args.request['sequence'],
                application: 'stellar-desktop',
                capabilities: [],
                build_revision: null,
              };
            if (command === 'ivy_snapshot') return snapshot;
            if (command === 'ivy_connect') {
              if (fixture.failConnect) {
                fixture.failConnect = false;
                throw 'timeout';
              }
              return snapshot;
            }
            if (command === 'ivy_reconcile') throw 'timeout';
            if (command === 'speech_snapshot' || command === 'speech_stop')
              return {
                version: 1,
                revision: '0',
                epoch: '0',
                operation_id: null,
                state: 'idle',
                error: null,
              };
            throw Error('Unexpected fault fixture command');
          },
        },
      },
    });
  }, uncertain);
  await page.goto('/');
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-ready',
    'true',
  );
}

test('failed Connect opens sanitized fault history and recovery clears the local fault', async ({
  page,
}) => {
  await install(page);
  const menu = page.getByRole('button', {
    name: 'Experience menu',
    exact: true,
  });
  await menu.click();
  await expect(page.getByText('Ivy connected', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __faultFixture: FaultFixture }
    ).__faultFixture.failConnect = true;
  });
  await page.getByRole('button', { name: 'Connect Ivy', exact: true }).click();
  const log = page.getByRole('region', { name: 'Recent errors' });
  await expect(log).toContainText('Ivy did not respond in time');
  await expect(
    page.getByRole('img', { name: 'Stellar emblem — error state' }),
  ).toBeVisible();
  await expect(log).toContainText('Active');
  await page.getByRole('button', { name: 'Try recovery' }).click();
  await expect(log).toContainText('Resolved');
  await expect(
    page.getByRole('img', { name: 'Stellar emblem — error state' }),
  ).toHaveCount(0);
  await expect(log).toHaveCount(0, { timeout: 6000 });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(
    page.getByText('Local voice idle', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Recent errors', exact: true })
    .click();
  await expect(log).toContainText('Resolved');
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __faultFixture: FaultFixture }
        ).__faultFixture.calls.filter((call) => call === 'ivy_submit').length,
    ),
  ).toBe(0);
});

test('failed check of a retained uncertain turn stays visible without resubmission', async ({
  page,
}) => {
  await install(page, true);
  const log = page.getByRole('region', { name: 'Recent errors' });
  await expect(log).toContainText('uncertain');
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Check response', exact: true })
    .click();
  await expect(page.getByText(/Ivy recovery timed out/)).toBeVisible();
  await expect(log).toContainText('Active');
  await expect(
    page.getByRole('button', { name: 'Send', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __faultFixture: FaultFixture }
        ).__faultFixture.calls.filter((call) => call === 'ivy_submit').length,
    ),
  ).toBe(0);
});
