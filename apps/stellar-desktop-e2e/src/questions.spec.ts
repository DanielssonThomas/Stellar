import { expect, test } from '@playwright/test';
import type { IvyQuestion, IvySnapshot } from '@stellar/desktop-contracts';

test('question card acknowledges display, traps focus and returns choices or typed answers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    let revision = 1;
    const replies: unknown[] = [];
    const state: IvySnapshot = {
      version: 1,
      revision: '1',
      turn_id: null,
      model: 'terra',
      verified_model: null,
      workspace_tools: 'unavailable',
      workspace_epoch: '0',
      reset_id: null,
      activity: [],
      connection: 'ready',
      turn: 'idle',
      items: [],
      error: null,
    };
    const emit = () => {
      state.revision = String(++revision);
      listeners.get('ivy-state')?.({ payload: structuredClone(state) });
    };
    Object.assign(window, {
      __questions: {
        replies,
        show: (id: string, multi_select = false) => {
          state.turn = 'admitted';
          state.turn_id = '11111111-2222-4333-8444-555555555555';
          state.questions = [
            {
              id,
              text: 'Which screen should I inspect?',
              choices: ['Left monitor', 'Right monitor'],
              multi_select,
              shown: false,
              answering: false,
            },
          ];
          emit();
        },
      },
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
            command: string,
            args: { request: Record<string, unknown> },
          ) => {
            if (command === 'app_info')
              return {
                version: 1,
                sequence: args.request['sequence'],
                application: 'stellar-desktop',
                capabilities: [],
                build_revision: null,
              };
            if (['ivy_snapshot', 'ivy_connect'].includes(command))
              return structuredClone(state);
            if (command === 'ivy_question_reply') {
              replies.push(args.request);
              const action = args.request['action'] as { kind: string };
              const question = state.questions?.find(
                (q: IvyQuestion) => q.id === args.request['prompt_id'],
              );
              if (question && action.kind === 'shown') question.shown = true;
              else state.questions = [];
              state.revision = String(++revision);
              return structuredClone(state);
            }
            if (
              command === 'speech_snapshot' ||
              command === 'speech_stop' ||
              command === 'speech_speak'
            )
              return {
                version: 1,
                revision: String(revision++),
                epoch: '0',
                operation_id: null,
                state: 'idle',
                error: null,
              };
            throw Error('Unexpected question fixture command');
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-ready',
    'true',
  );
  const show = (id: string, multi = false) =>
    page.evaluate(
      ({ id, multi }) => {
        (
          window as unknown as {
            __questions: { show: (id: string, multi: boolean) => void };
          }
        ).__questions.show(id, multi);
      },
      { id, multi },
    );
  await show('q1');
  const dialog = page.getByRole('dialog', {
    name: 'Could you check this out?',
  });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Left monitor' }),
  ).toBeEnabled();
  expect(
    await dialog.evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
  await page.keyboard.press('m');
  await expect(
    page.getByRole('dialog', { name: 'Experience controls', exact: true }),
  ).toBeHidden();
  await page.screenshot({ path: 'test-results/ivy-question-card.png' });
  await page.getByRole('button', { name: 'Left monitor' }).click();
  await expect(dialog).toBeHidden();
  await show('q2', true);
  await page.getByRole('button', { name: 'Left monitor' }).click();
  await page.getByRole('button', { name: 'Right monitor' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(dialog).toBeHidden();
  await show('q3');
  await page
    .getByRole('textbox', { name: 'Or tell me in your own words' })
    .fill('The screen with Chrome');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(dialog).toBeHidden();
  await show('q4');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const replies = await page.evaluate(
    () =>
      (window as unknown as { __questions: { replies: unknown[] } }).__questions
        .replies,
  );
  expect(replies).toEqual([
    { version: 1, prompt_id: 'q1', action: { kind: 'shown' } },
    {
      version: 1,
      prompt_id: 'q1',
      action: { kind: 'answer', answer: 'Left monitor' },
    },
    { version: 1, prompt_id: 'q2', action: { kind: 'shown' } },
    {
      version: 1,
      prompt_id: 'q2',
      action: { kind: 'answer', answer: '["Left monitor","Right monitor"]' },
    },
    { version: 1, prompt_id: 'q3', action: { kind: 'shown' } },
    {
      version: 1,
      prompt_id: 'q3',
      action: { kind: 'answer', answer: 'The screen with Chrome' },
    },
    { version: 1, prompt_id: 'q4', action: { kind: 'shown' } },
    { version: 1, prompt_id: 'q4', action: { kind: 'cancel' } },
  ]);
});
