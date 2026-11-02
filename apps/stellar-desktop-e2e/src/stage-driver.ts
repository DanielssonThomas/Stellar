import type { Page } from '@playwright/test';

export const controlPane = (
  page: Page,
  action: 'minimize' | 'close',
  id = 'requested-content',
) =>
  page.evaluate(
    ({ action, id }) => {
      const root = document.querySelector('stellar-root');
      if (!root) throw new Error('Missing root');
      const debug = window as unknown as {
        ng: {
          getComponent(element: Element): {
            view(): { stage(): { control(action: string, id: string): void } };
          };
        };
      };
      debug.ng.getComponent(root).view().stage().control(action, id);
    },
    { action, id },
  );

export const openPane = (
  page: Page,
  commandId: number,
  instanceId: string,
  title: string,
  body: string,
  prominence: 'primary' | 'secondary' = 'secondary',
) =>
  page.evaluate(
    (command) => {
      const root = document.querySelector('stellar-root');
      if (!root) throw new Error('Missing root');
      const debug = window as unknown as {
        ng: {
          getComponent(element: Element): {
            experience: { present(command: unknown): { status: string } };
          };
        };
      };
      return debug.ng.getComponent(root).experience.present(command).status;
    },
    {
      contractVersion: 1,
      commandId,
      instanceId,
      action: 'open',
      surface: 'assistant-message',
      prominence,
      payload: { title, body },
    },
  );
