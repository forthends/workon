import type { Clock } from './clock.js';
import type { Store } from './store.js';

export type ProcessKiller = {
  isAlive(pid: number): boolean;
  killGroup(pid: number): Promise<void>;
};

export async function recoverInterrupted(deps: {
  store: Store;
  clock: Clock;
  killer: ProcessKiller;
  notify(summary: string): void;
}): Promise<void> {
  const { store, killer } = deps;
  const now = () => deps.clock.now().toISOString();

  const requirements = store.listByStatuses(['routing', 'in_progress']);

  for (const requirement of requirements) {
    const attempts = store.listAttempts(requirement.id);
    for (const attempt of attempts) {
      if (attempt.status === 'running' && attempt.pid !== null && killer.isAlive(attempt.pid)) {
        await killer.killGroup(attempt.pid);
      }
    }

    const newCount = requirement.consecutiveInterruptions + 1;
    const stamp = now();
    let notifySummary: string;

    store.transaction(() => {
      if (newCount < 2) {
        for (const attempt of attempts) {
          if (attempt.status === 'running') {
            store.updateAttempt(requirement.id, attempt.n, { status: 'interrupted', finishedAt: stamp });
          }
        }
        store.updateRequirement(requirement.id, requirement.status, {
          status: 'queued',
          needsHumanClass: null,
          consecutiveInterruptions: newCount,
          updatedAt: stamp,
        });
        store.insertEvent({ requirementId: requirement.id, type: 'requirement.requeued', payload: {}, now: stamp });
        store.insertInbox({
          requirementId: requirement.id,
          kind: 'interrupted_retry',
          summary: '已中断，将自动重试',
          now: stamp,
        });
        notifySummary = '已中断，将自动重试';
      } else {
        store.updateRequirement(requirement.id, requirement.status, {
          status: 'needs_human',
          needsHumanClass: 'interrupted',
          consecutiveInterruptions: newCount,
          updatedAt: stamp,
        });
        store.insertEvent({
          requirementId: requirement.id,
          type: 'requirement.needs_human',
          payload: { needsHumanClass: 'interrupted' },
          now: stamp,
        });
        store.insertInbox({
          requirementId: requirement.id,
          kind: 'needs_human',
          summary: '连续中断，等待 retry',
          now: stamp,
        });
        notifySummary = '连续中断，等待 retry';
      }
    });

    try {
      deps.notify(notifySummary!);
    } catch {
      /* 收件箱已提交 */
    }
  }
}
