import { describe, expect, it, vi } from 'vitest';
import type { ReflexPlan, ReflexRequest } from '@stellar/desktop-contracts';
import { ReflexController } from './reflex-controller';
import { LocalActionRegistry } from './action-registry';

const plan: ReflexPlan = {
  route: 'action',
  action_id: 'media.next',
  reply: 'That song had it coming.',
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
function fixture() {
  let epoch = 'one',
    valid = true;
  const execute = vi.fn(async () => 'confirmed' as const);
  const infer = vi.fn(
    async (_r: ReflexRequest, _s: AbortSignal): Promise<ReflexPlan | null> =>
      plan,
  );
  const controller = new ReflexController({
    currentEpoch: () => epoch,
    infer,
    environment: async () => ({
      epoch,
      context: '{}',
      actions: [
        {
          id: 'media.next',
          description: 'Skip current track',
          valid: () => valid,
          execute,
        },
      ],
    }),
  });
  return {
    controller,
    infer,
    execute,
    stale: () => (valid = false),
    rotate: () => (epoch = 'two'),
  };
}

describe('Reflex routing and execution', () => {
  it('never turns a confirmed effect into cloud fallback when an observer fails', async () => {
    const execute = vi.fn(async () => 'confirmed' as const);
    const controller = new ReflexController({
      currentEpoch: () => 'one',
      infer: async () => plan,
      point: () => {
        throw new Error('diagnostics unavailable');
      },
      environment: async () => ({
        epoch: 'one',
        context: '{}',
        actions: [
          { id: 'media.next', description: 'Skip', valid: () => true, execute },
        ],
      }),
    });
    expect(await controller.run('skip', 'one', 'professional')).toMatchObject({
      handled: true,
      outcome: 'confirmed',
      reply: plan.reply,
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it('holds personality acknowledgment until the executor confirms and records a compact event', async () => {
    const f = fixture(),
      done = deferred<'confirmed'>();
    f.execute.mockImplementationOnce(() => done.promise);
    const running = f.controller.run('skip this garbage', 'one', 'playful');
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    expect(f.controller.events()).toEqual([]);
    done.resolve('confirmed');
    expect(await running).toEqual({
      handled: true,
      reply: plan.reply,
      outcome: 'confirmed',
    });
    expect(f.controller.events()).toEqual([
      {
        action: 'media.next',
        target: 'Skip current track',
        outcome: 'confirmed',
        reply: plan.reply,
      },
    ]);
    expect(
      (await f.controller.run('skip again', 'one', 'playful')).outcome,
    ).toBe('rejected');
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('delegates complex and unavailable-model requests without executing', async () => {
    for (const value of [
      null,
      {
        route: 'hermes',
        action_id: null,
        reply: 'Let me think.',
      } as ReflexPlan,
    ]) {
      const f = fixture();
      f.infer.mockResolvedValue(value);
      expect(
        (await f.controller.run('refactor the backend', 'one', 'professional'))
          .handled,
      ).toBe(false);
      expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it('retains clarification context and mode, but clears it on a foreground change', async () => {
    const f = fixture();
    f.infer.mockResolvedValueOnce({
      route: 'clarify',
      action_id: null,
      reply: 'Which pane?',
    });
    expect(
      (await f.controller.run('close that pane', 'one', 'professional'))
        .outcome,
    ).toBe('clarify');
    await f.controller.run('the left one', 'two', 'professional');
    expect(f.infer.mock.calls[1][0]).toMatchObject({
      mode: 'professional',
      history: [
        JSON.stringify({ user: 'close that pane', ivy: 'Which pane?' }),
      ],
    });
    f.rotate();
    expect(f.controller.events()).toEqual([]);
  });
  it('rejects stale actions and arbitrary tool names', async () => {
    for (const unknown of [false, true]) {
      const f = fixture();
      f.infer.mockImplementation(async () => {
        f.stale();
        return { ...plan, action_id: unknown ? 'shell.exec' : plan.action_id };
      });
      expect((await f.controller.run('skip', 'one', 'playful')).outcome).toBe(
        'rejected',
      );
      expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it('cancels delayed inference and rejects concurrent requests without side effects', async () => {
    const f = fixture(),
      pending = deferred<ReflexPlan | null>();
    f.infer.mockReturnValue(pending.promise);
    const first = f.controller.run('skip', 'one', 'playful');
    await vi.waitFor(() => expect(f.infer).toHaveBeenCalledOnce());
    expect((await f.controller.run('skip', 'two', 'playful')).outcome).toBe(
      'rejected',
    );
    f.controller.cancel();
    pending.resolve(plan);
    expect((await first).outcome).toBe('cancelled');
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('does not fall through to cloud after unknown executor completion or cancellation', async () => {
    const execute = vi.fn(async (): Promise<'confirmed'> => {
      throw new Error('lost receipt');
    });
    const controller = new ReflexController({
      currentEpoch: () => 'one',
      infer: async () => plan,
      environment: async () => ({
        epoch: 'one',
        context: '{}',
        actions: [
          { id: 'media.next', description: 'skip', valid: () => true, execute },
        ],
      }),
    });
    expect(await controller.run('skip', 'one', 'playful')).toMatchObject({
      handled: true,
      outcome: 'uncertain',
    });
    expect(controller.events()[0].outcome).toBe('uncertain');
  });
  it('fences an epoch changed during inference', async () => {
    const f = fixture();
    f.infer.mockImplementation(async () => {
      f.rotate();
      return plan;
    });
    expect((await f.controller.run('skip', 'one', 'playful')).outcome).toBe(
      'cancelled',
    );
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('keeps a request-scoped registry single-use even after a failed action', async () => {
    const execute = vi.fn(() => 'rejected' as const);
    const registry = new LocalActionRegistry([
      { id: 'media.next', description: 'Skip', valid: () => true, execute },
    ]);
    const signal = new AbortController().signal;
    await registry.dispatch('media.next', 'one', signal);
    await registry.dispatch('media.next', 'one', signal);
    expect(execute).toHaveBeenCalledOnce();
    expect(
      () =>
        new LocalActionRegistry([
          { id: 'x;rm', description: '', valid: () => true, execute },
        ]),
    ).toThrow();
  });
});
