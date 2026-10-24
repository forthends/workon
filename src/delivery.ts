import type { Clock } from './clock.js';
import { WorkonError } from './errors.js';
import { routeRequirement } from './router.js';
import type { Store } from './store.js';
import type { Assignment, ExecutionReport, Requirement, RequirementDetail } from './types.js';

export interface Delivery {
  submit(text: string): { id: string; status: 'queued' };
  claimNext(): Assignment | null;
  onReport(requirementId: string, report: ExecutionReport): void;
  accept(id: string): { status: 'accepted'; artifactKey: string };
  reject(id: string, comment: string): { status: 'queued' };
  supplement(id: string, text: string): { status: 'queued' };
  retry(id: string): { status: 'queued' };
  get(id: string): RequirementDetail;
  list(): Requirement[];
}

export function createDelivery(deps: { store: Store; clock: Clock; notify(summary: string): void }): Delivery {
  const { store } = deps;
  const now = () => deps.clock.now().toISOString();
  const safeNotify = (summary: string) => {
    try { deps.notify(summary); } catch { /* 收件箱已提交 */ }
  };
  const requireExisting = (id: string): Requirement => {
    const requirement = store.getRequirement(id);
    if (!requirement) throw new WorkonError(404, 'not_found', '需求不存在');
    return requirement;
  };
  const requeue = (id: string, expected: Requirement['status'], stamp: string, kind: string) => {
    store.updateRequirement(id, expected, { status: 'queued', needsHumanClass: null, consecutiveInterruptions: 0, updatedAt: stamp });
    store.insertEvent({ requirementId: id, type: 'requirement.requeued', payload: { kind }, now: stamp });
  };

  return {
    submit(text) {
      const trimmed = text.trim();
      if (!trimmed) throw new WorkonError(400, 'invalid', '正文不能为空');
      const stamp = now();
      return store.transaction(() => {
        const requirement = store.insertRequirement({ text: trimmed, now: stamp });
        store.insertEvent({ requirementId: requirement.id, type: 'requirement.submitted', payload: {}, now: stamp });
        return { id: requirement.id, status: 'queued' as const };
      });
    },
    claimNext() {
      return store.transaction(() => {
        if (store.listByStatuses(['routing', 'in_progress']).length > 0) return null;
        const next = store.oldestQueued();
        if (!next) return null;
        const stamp = now();
        store.updateRequirement(next.id, 'queued', { status: 'in_progress', route: 'prd', updatedAt: stamp });
        store.insertEvent({ requirementId: next.id, type: 'requirement.routed', payload: { route: 'prd' }, now: stamp });
        store.insertEvent({ requirementId: next.id, type: 'requirement.run_started', payload: {}, now: stamp });
        return routeRequirement(next.id);
      });
    },
    onReport(requirementId, report) {
      const stamp = now();
      let summary = '';
      store.transaction(() => {
        const current = requireExisting(requirementId);
        if (current.status !== 'in_progress') throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        if (report.outcome === 'completed' && report.artifact && report.winningAttempt !== undefined) {
          store.updateAttempt(requirementId, report.winningAttempt, { status: 'completed', finishedAt: stamp, error: null });
          store.insertArtifact({ requirementId, attemptN: report.winningAttempt, key: report.artifact.key, url: report.artifact.url, now: stamp });
          store.updateRequirement(requirementId, 'in_progress', { status: 'awaiting_acceptance', needsHumanClass: null, consecutiveInterruptions: 0, updatedAt: stamp });
          summary = 'PRD 待验收';
          store.insertInbox({ requirementId, kind: 'awaiting_acceptance', summary, now: stamp });
          store.insertEvent({ requirementId, type: 'requirement.awaiting_acceptance', payload: { artifactKey: report.artifact.key }, now: stamp });
          store.insertEvent({ requirementId, type: 'attempt.finished', payload: { n: report.winningAttempt, status: 'completed' }, now: stamp });
          return;
        }
        if (report.outcome === 'blocked' && report.winningAttempt !== undefined) {
          const reason = report.reason?.trim() || '需要补充信息';
          store.updateAttempt(requirementId, report.winningAttempt, { status: 'blocked', finishedAt: stamp, error: reason });
          store.updateRequirement(requirementId, 'in_progress', { status: 'needs_human', needsHumanClass: 'content', consecutiveInterruptions: 0, updatedAt: stamp });
          summary = reason;
          store.insertInbox({ requirementId, kind: 'needs_human', summary, now: stamp });
          store.insertEvent({ requirementId, type: 'requirement.needs_human', payload: { needsHumanClass: 'content' }, now: stamp });
          store.insertEvent({ requirementId, type: 'attempt.finished', payload: { n: report.winningAttempt, status: 'blocked' }, now: stamp });
          return;
        }
        summary = '客户端未能完成，等待 retry';
        store.updateRequirement(requirementId, 'in_progress', { status: 'needs_human', needsHumanClass: 'clients', consecutiveInterruptions: 0, updatedAt: stamp });
        store.insertInbox({ requirementId, kind: 'needs_human', summary, now: stamp });
        store.insertEvent({ requirementId, type: 'requirement.needs_human', payload: { needsHumanClass: 'clients' }, now: stamp });
      });
      safeNotify(summary);
    },
    accept(id) {
      const stamp = now();
      const result = store.transaction(() => {
        const current = requireExisting(id);
        if (current.status !== 'awaiting_acceptance') throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        const artifact = store.latestArtifact(id);
        if (!artifact) throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        store.updateRequirement(id, 'awaiting_acceptance', { status: 'accepted', acceptedArtifactId: artifact.id, updatedAt: stamp });
        store.insertInbox({ requirementId: id, kind: 'accepted', summary: 'PRD 已接受', now: stamp });
        store.insertEvent({ requirementId: id, type: 'requirement.accepted', payload: { artifactKey: artifact.key }, now: stamp });
        return { status: 'accepted' as const, artifactKey: artifact.key };
      });
      safeNotify('PRD 已接受');
      return result;
    },
    reject(id, comment) {
      const body = comment.trim();
      if (!body) throw new WorkonError(400, 'invalid', '正文不能为空');
      const stamp = now();
      return store.transaction(() => {
        const current = requireExisting(id);
        if (current.status !== 'awaiting_acceptance') throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        store.insertNote({ requirementId: id, kind: 'reject', body, now: stamp });
        requeue(id, 'awaiting_acceptance', stamp, 'reject');
        return { status: 'queued' as const };
      });
    },
    supplement(id, text) {
      const body = text.trim();
      if (!body) throw new WorkonError(400, 'invalid', '正文不能为空');
      const stamp = now();
      return store.transaction(() => {
        const current = requireExisting(id);
        if (current.status !== 'needs_human' || current.needsHumanClass !== 'content') {
          throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        }
        store.insertNote({ requirementId: id, kind: 'supplement', body, now: stamp });
        requeue(id, 'needs_human', stamp, 'supplement');
        return { status: 'queued' as const };
      });
    },
    retry(id) {
      const stamp = now();
      return store.transaction(() => {
        const current = requireExisting(id);
        if (current.status !== 'needs_human' || (current.needsHumanClass !== 'clients' && current.needsHumanClass !== 'interrupted')) {
          throw new WorkonError(409, 'conflict', '当前状态不允许该操作', current.status);
        }
        requeue(id, 'needs_human', stamp, 'retry');
        return { status: 'queued' as const };
      });
    },
    get(id) {
      const requirement = requireExisting(id);
      return { ...requirement, notes: store.listNotes(id), attempts: store.listAttempts(id), artifacts: store.listArtifacts(id) };
    },
    list() { return store.listRequirements(); },
  };
}
