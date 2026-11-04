import { expect, test, type Page } from '@playwright/test';
import type {
  WorkspaceToolOperation,
  WorkspaceToolOutcome,
} from '@stellar/desktop-contracts';

type Fixture = {
  request(operation: WorkspaceToolOperation): Promise<WorkspaceToolOutcome>;
  calls: string[];
};
async function request(page: Page, operation: WorkspaceToolOperation) {
  return page.evaluate(
    (operation) =>
      (window as unknown as { workspace290: Fixture }).workspace290.request(
        operation,
      ),
    operation,
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    const pending = new Map<string, (outcome: WorkspaceToolOutcome) => void>();
    const turn = '00000000-0000-4000-8000-000000000001';
    let revision = 0;
    let active = false;
    const state = () => ({
      version: 1,
      revision: String(++revision),
      model: 'terra',
      verified_model: null,
      workspace_tools: 'available',
      workspace_epoch: '2',
      reset_id: null,
      turn_id: active ? turn : null,
      connection: 'ready',
      turn: active ? 'admitted' : 'idle',
      activity: [],
      items: [],
      error: null,
    });
    const fixture: Fixture = {
      calls: [],
      request(operation) {
        active = true;
        listeners.get('ivy-state')?.({ payload: state() });
        const request_id = crypto.randomUUID().replaceAll('-', '');
        return new Promise((resolve) => {
          pending.set(request_id, resolve);
          listeners.get('workspace-tool-request')?.({
            payload: {
              version: 1,
              request_id,
              epoch: '2',
              turn_id: turn,
              expires_at_ms: String(Date.now() + 15000),
              operation,
            },
          });
        });
      },
    };
    Object.assign(window, {
      workspace290: fixture,
      __TAURI__: {
        event: {
          listen: async (
            name: string,
            callback: (event: { payload: unknown }) => void,
          ) => {
            listeners.set(name, callback);
            return () => listeners.delete(name);
          },
        },
        core: {
          invoke: async (
            name: string,
            args?: { request?: Record<string, unknown> },
          ) => {
            fixture.calls.push(name);
            if (name === 'app_info')
              return {
                version: 1,
                sequence: args?.request?.['sequence'],
                application: 'Stellar Desktop',
                capabilities: [],
                build_revision: null,
              };
            if (name === 'ivy_connect' || name === 'ivy_snapshot')
              return state();
            if (name === 'workspace_tool_reply') {
              const id = String(args?.request?.['request_id']);
              pending.get(id)?.(
                args?.request?.['outcome'] as WorkspaceToolOutcome,
              );
              pending.delete(id);
              return;
            }
            if (name === 'reflex_set_enabled') return;
            if (name === 'reflex_status')
              return { version: 1, configured: true };
            if (name === 'reflex_prepare') return new Promise(() => undefined);
            if (name === 'speech_snapshot' || name === 'speech_stop')
              return {
                version: 1,
                revision: '1',
                operation_id: null,
                state: 'idle',
                error: null,
              };
            throw Error('Unexpected fixture command: ' + name);
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.emblem')).toBeVisible();
});

const image = (id: string, src: string): WorkspaceToolOperation => ({
  kind: 'open',
  instance_id: id,
  surface: 'image',
  prominence: 'secondary',
  payload_json: JSON.stringify({ title: id, src, alt: id }),
});

test('actual image success and failure reach Ivy through correlated settled inspection', async ({
  page,
}, info) => {
  expect(
    await request(page, image('rendered', '/emblem/layers/gold-body.png')),
  ).toEqual({ kind: 'applied' });
  expect(
    await request(page, image('failed', '/emblem/layers/missing-image.png')),
  ).toEqual({ kind: 'applied' });
  const observation = await request(page, { kind: 'inspect' });
  expect(observation).toMatchObject({
    kind: 'inspection',
    panes: [
      {
        instance_id: 'rendered',
        render_state: 'ready',
        layout: { width: expect.any(Number) },
      },
      { instance_id: 'failed', render_state: 'error' },
    ],
  });
  await expect
    .poll(() =>
      page
        .locator('[data-instance-id="rendered"] img.media-image')
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(page.locator('[data-instance-id="failed"]')).toContainText(
    'Image unavailable',
  );
  await page.screenshot({
    path: info.outputPath('workspace-render-observation.png'),
  });
});

test('swap shorthand changes the actual two-pane layout without waiting for a model', async ({
  page,
}) => {
  for (const id of ['one', 'two'])
    await request(page, {
      kind: 'open',
      instance_id: id,
      surface: 'assistant-message',
      prominence: 'secondary',
      payload_json: JSON.stringify({ title: id, body: 'Retained ' + id }),
    });
  await request(page, { kind: 'inspect' });
  const one = page.locator('[data-instance-id="one"]');
  await one.evaluate((element) => {
    (element as HTMLElement).dataset['retained'] = 'yes';
  });
  for (const text of ['swap', 'swap pane', 'swap the pane positions']) {
    const before = await one.boundingBox();
    const outcome = await page.evaluate(async (text) => {
      const app = (
        window as unknown as {
          ng: {
            getComponent(element: Element): {
              reflex: {
                run(text: string, id: string): Promise<{ outcome: string }>;
              };
            };
          };
        }
      ).ng.getComponent(document.querySelector('stellar-root') as Element);
      return app.reflex.run(text, crypto.randomUUID());
    }, text);
    expect(outcome.outcome).toBe('confirmed');
    await request(page, { kind: 'inspect' });
    expect((await one.boundingBox())?.x).not.toBe(before?.x);
    await expect(one).toHaveAttribute('data-retained', 'yes');
  }
  const calls = await page.evaluate(
    () => (window as unknown as { workspace290: Fixture }).workspace290.calls,
  );
  expect(calls).not.toContain('reflex_infer');
  expect(calls).not.toContain('reflex_media_snapshot');
  expect(calls).not.toContain('ivy_submit');
});
