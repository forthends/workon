import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverInterrupted, type ProcessKiller } from '../src/recovery.js';
import { testStore } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function killer(overrides: Partial<ProcessKiller> = {}): ProcessKiller {
  return {
    isAlive: overrides.isAlive ?? (() => true),
    killGroup: overrides.killGroup ?? vi.fn(async () => undefined),
  };
}

describe('recoverInterrupted', () => {
  it('requeues after the first interruption and kills a live process group', async () => {
    const { store, clock, cleanup } = testStore();
    cleanups.push(cleanup);
    const stamp = clock.now().toISOString();
    const created = store.insertRequirement({ text: '需求', now: stamp });
    store.updateRequirement(created.id, 'queued', { status: 'in_progress', updatedAt: stamp });
    store.insertAttempt({
      requirementId: created.id,
      n: 1,
      clientId: 'qoder',
      status: 'running',
      pid: 42,
      runDir: '/tmp/run',
      error: null,
      startedAt: stamp,
      finishedAt: null,
    });
    const killGroup = vi.fn(async () => undefined);
    await recoverInterrupted({ store, clock, killer: killer({ killGroup }), notify: () => undefined });

    expect(killGroup).toHaveBeenCalledWith(42);
    const requirement = store.getRequirement(created.id);
    expect(requirement?.status).toBe('queued');
    expect(requirement?.consecutiveInterruptions).toBe(1);
    expect(requirement?.needsHumanClass).toBeNull();
    expect(store.listAttempts(created.id)[0]?.status).toBe('interrupted');
    expect(store.listInbox().map((item) => item.summary)).toEqual(['已中断，将自动重试']);
    expect(store.listEvents(created.id).map((event) => event.type)).toEqual(['requirement.requeued']);
  });

  it('escalates to needs_human on the second interruption', async () => {
    const { store, clock, cleanup } = testStore();
    cleanups.push(cleanup);
    const stamp = clock.now().toISOString();
    const created = store.insertRequirement({ text: '需求', now: stamp });
    store.updateRequirement(created.id, 'queued', {
      status: 'in_progress',
      consecutiveInterruptions: 1,
      updatedAt: stamp,
    });
    store.insertAttempt({
      requirementId: created.id,
      n: 1,
      clientId: 'qoder',
      status: 'running',
      pid: 42,
      runDir: '/tmp/run',
      error: null,
      startedAt: stamp,
      finishedAt: null,
    });
    await recoverInterrupted({ store, clock, killer: killer(), notify: () => undefined });

    const requirement = store.getRequirement(created.id);
    expect(requirement?.status).toBe('needs_human');
    expect(requirement?.needsHumanClass).toBe('interrupted');
    expect(requirement?.consecutiveInterruptions).toBe(2);
    expect(store.listAttempts(created.id)[0]?.status).toBe('running');
    expect(store.listInbox().map((item) => item.summary)).toEqual(['连续中断，等待 retry']);
    expect(store.listEvents(created.id).at(-1)?.type).toBe('requirement.needs_human');
    expect(store.listEvents(created.id).at(-1)?.payload).toEqual({ needsHumanClass: 'interrupted' });
  });

  it('recovers routing requirements without attempts', async () => {
    const { store, clock, cleanup } = testStore();
    cleanups.push(cleanup);
    const stamp = clock.now().toISOString();
    const created = store.insertRequirement({ text: '路由中', now: stamp });
    store.updateRequirement(created.id, 'queued', { status: 'routing', updatedAt: stamp });

    await recoverInterrupted({ store, clock, killer: killer(), notify: () => undefined });

    const requirement = store.getRequirement(created.id);
    expect(requirement?.status).toBe('queued');
    expect(requirement?.consecutiveInterruptions).toBe(1);
    expect(store.listInbox().map((item) => item.summary)).toEqual(['已中断，将自动重试']);
  });

  it('still commits state when notify throws', async () => {
    const { store, clock, cleanup } = testStore();
    cleanups.push(cleanup);
    const stamp = clock.now().toISOString();
    const created = store.insertRequirement({ text: '需求', now: stamp });
    store.updateRequirement(created.id, 'queued', { status: 'in_progress', updatedAt: stamp });
    store.insertAttempt({
      requirementId: created.id,
      n: 1,
      clientId: 'qoder',
      status: 'running',
      pid: 42,
      runDir: '/tmp/run',
      error: null,
      startedAt: stamp,
      finishedAt: null,
    });

    await recoverInterrupted({
      store,
      clock,
      killer: killer(),
      notify: () => {
        throw new Error('notify failed');
      },
    });

    expect(store.getRequirement(created.id)?.status).toBe('queued');
    expect(store.listInbox().map((item) => item.summary)).toEqual(['已中断，将自动重试']);
  });
});
