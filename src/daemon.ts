import type { Delivery } from './delivery.js';
import type { createWake } from './wake.js';
import type { Assignment, ExecutionReport } from './types.js';

export async function runDaemon(deps: {
  delivery: Delivery;
  role: { handle(assignment: Assignment): Promise<ExecutionReport> };
  recover(): Promise<void>;
  wake: ReturnType<typeof createWake>;
  signal: AbortSignal;
}): Promise<void> {
  await deps.recover();
  deps.wake.wake();

  while (!deps.signal.aborted) {
    const assignment = deps.delivery.claimNext();
    if (assignment) {
      try {
        const report = await deps.role.handle(assignment);
        if (deps.signal.aborted) return;
        deps.delivery.onReport(assignment.requirementId, report);
      } catch (error) {
        if (deps.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        deps.delivery.onReport(assignment.requirementId, {
          outcome: 'failed',
          needsHumanClass: 'clients',
          reason: message,
          attempts: [],
        });
      }
      continue;
    }

    await deps.wake.wait(deps.signal);
    if (deps.signal.aborted) return;
  }
}
