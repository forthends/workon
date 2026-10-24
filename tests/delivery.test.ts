import { afterEach, describe, expect, it } from 'vitest';
import { createDelivery } from '../src/delivery.js';
import { WorkonError } from '../src/errors.js';
import { testStore } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(notify: (summary: string) => void = () => undefined) {
  const ctx = testStore();
  cleanups.push(ctx.cleanup);
  const delivery = createDelivery({ store: ctx.store, clock: ctx.clock, notify });
  return { ...ctx, delivery };
}

function runningAttempt(store: ReturnType<typeof testStore>['store'], requirementId: string) {
  store.insertAttempt({
    requirementId,
    n: 1,
    clientId: 'qoder',
    status: 'running',
    pid: null,
    runDir: '/tmp/run',
    error: null,
    startedAt: '2026-10-24T00:00:03.000Z',
    finishedAt: null,
  });
}

describe('delivery', () => {
  it('rejects a blank submission', () => {
    const { delivery, store } = setup();
    expect(() => delivery.submit('   ')).toThrow(WorkonError);
    try {
      delivery.submit('   ');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400, error: 'invalid', message: '正文不能为空' });
    }
    expect(store.listRequirements()).toEqual([]);
  });

  it('trims and records a submission', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('  做一个导出  ');
    expect(created.status).toBe('queued');
    expect(store.getRequirement(created.id)?.text).toBe('做一个导出');
    expect(store.listEvents(created.id).map((event) => event.type)).toEqual(['requirement.submitted']);
  });

  it('claims the earliest queued requirement and holds the lock', () => {
    const { delivery, store, clock } = setup();
    const first = delivery.submit('第一');
    clock.advance(1000);
    const second = delivery.submit('第二');
    expect(delivery.claimNext()).toEqual({
      requirementId: first.id,
      route: 'prd',
      role: 'product',
      skillId: 'workon-prd',
      size: 'unclassified',
    });
    expect(store.getRequirement(first.id)?.status).toBe('in_progress');
    expect(store.getRequirement(first.id)?.route).toBe('prd');
    expect(store.listEvents(first.id).map((event) => event.type)).toEqual([
      'requirement.submitted',
      'requirement.routed',
      'requirement.run_started',
    ]);
    expect(delivery.claimNext()).toBeNull();
    expect(store.getRequirement(second.id)?.status).toBe('queued');
  });

  it('keeps awaiting acceptance when notification throws', () => {
    const { delivery, store } = setup(() => {
      throw new Error('notify failed');
    });
    const created = delivery.submit('需求');
    delivery.claimNext();
    runningAttempt(store, created.id);
    delivery.onReport(created.id, {
      outcome: 'completed',
      clientId: 'qoder',
      winningAttempt: 1,
      artifact: { key: `requirements/${created.id}/attempts/1/prd.md`, url: 'file:///tmp/prd.md' },
      attempts: [{ n: 1, clientId: 'qoder', status: 'completed' }],
    });
    const requirement = store.getRequirement(created.id);
    expect(requirement?.status).toBe('awaiting_acceptance');
    expect(requirement?.consecutiveInterruptions).toBe(0);
    expect(store.listInbox().map((item) => item.summary)).toEqual(['PRD 待验收']);
    expect(store.latestArtifact(created.id)?.key).toBe(`requirements/${created.id}/attempts/1/prd.md`);
  });

  it('turns a blank blocked reason into the fixed summary', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    runningAttempt(store, created.id);
    delivery.onReport(created.id, {
      outcome: 'blocked',
      reason: '   ',
      needsHumanClass: 'content',
      winningAttempt: 1,
      clientId: 'qoder',
      attempts: [{ n: 1, clientId: 'qoder', status: 'blocked' }],
    });
    expect(store.getRequirement(created.id)?.needsHumanClass).toBe('content');
    expect(store.listInbox()[0]?.summary).toBe('需要补充信息');
  });

  it('parks client failure for retry', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    delivery.onReport(created.id, { outcome: 'failed', needsHumanClass: 'clients', attempts: [] });
    expect(store.getRequirement(created.id)?.needsHumanClass).toBe('clients');
    expect(store.listInbox()[0]?.summary).toBe('客户端未能完成，等待 retry');
  });

  it('accepts once and reports conflict on the second accept', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    runningAttempt(store, created.id);
    const key = `requirements/${created.id}/attempts/1/prd.md`;
    delivery.onReport(created.id, {
      outcome: 'completed',
      winningAttempt: 1,
      clientId: 'qoder',
      artifact: { key, url: 'file:///tmp/prd.md' },
      attempts: [],
    });
    expect(delivery.accept(created.id)).toEqual({ status: 'accepted', artifactKey: key });
    const before = store.listInbox().length;
    expect(() => delivery.accept(created.id)).toThrow(WorkonError);
    expect(store.listInbox()).toHaveLength(before);
    expect(store.listInbox().at(-1)?.summary).toBe('PRD 已接受');
  });

  it('requeues a rejection with the trimmed note and no inbox row', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    runningAttempt(store, created.id);
    delivery.onReport(created.id, {
      outcome: 'completed',
      winningAttempt: 1,
      clientId: 'qoder',
      artifact: { key: 'requirements/x/attempts/1/prd.md', url: 'file:///tmp/prd.md' },
      attempts: [],
    });
    const inboxBefore = store.listInbox().length;
    expect(delivery.reject(created.id, '  意见  ')).toEqual({ status: 'queued' });
    expect(store.listNotes(created.id)).toMatchObject([{ kind: 'reject', body: '意见' }]);
    expect(store.getRequirement(created.id)?.consecutiveInterruptions).toBe(0);
    expect(store.listEvents(created.id).at(-1)?.type).toBe('requirement.requeued');
    expect(store.listInbox()).toHaveLength(inboxBefore);
  });

  it('supplements only content blocks and retries only client or interrupt blocks', () => {
    const { delivery, store } = setup();
    const created = delivery.submit('需求');
    delivery.claimNext();
    delivery.onReport(created.id, { outcome: 'failed', needsHumanClass: 'clients', attempts: [] });
    expect(() => delivery.supplement(created.id, '补充')).toThrow(WorkonError);
    try {
      delivery.supplement(created.id, '补充');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, requirementStatus: 'needs_human' });
    }
    expect(delivery.retry(created.id).status).toBe('queued');
    delivery.claimNext();
    runningAttempt(store, created.id);
    delivery.onReport(created.id, {
      outcome: 'blocked',
      reason: '缺用户',
      needsHumanClass: 'content',
      winningAttempt: 1,
      clientId: 'qoder',
      attempts: [],
    });
    expect(() => delivery.retry(created.id)).toThrow(WorkonError);
    expect(delivery.supplement(created.id, '用户是管理员').status).toBe('queued');
    expect(store.listNotes(created.id).at(-1)).toMatchObject({ kind: 'supplement', body: '用户是管理员' });
  });

  it('returns not found for an unknown id', () => {
    const { delivery } = setup();
    expect(() => delivery.accept('req_missing')).toThrow(WorkonError);
    try {
      delivery.accept('req_missing');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 404, message: '需求不存在' });
    }
  });
});
