import { createCursorAdapter, createQoderAdapter, type CommandRunner } from './adapters.js';
import { createArtifactStore } from './artifacts.js';
import type { Clock } from './clock.js';
import { runWithFallback } from './selector.js';
import { loadSkill } from './skills.js';
import type { Store } from './store.js';
import type { Assignment } from './types.js';

export function createProductRole(deps: {
  commands: { qoder: string; cursor: string };
  runner: CommandRunner;
  store: Store;
  clock: Clock;
  workspaceRoot: string;
}) {
  return {
    async handle(assignment: Assignment) {
      const requirement = deps.store.getRequirement(assignment.requirementId);
      if (!requirement) throw new Error('需求不存在');
      const notes = deps.store.listNotes(assignment.requirementId);
      const skill = loadSkill(deps.workspaceRoot);
      return runWithFallback({
        adapters: [
          createQoderAdapter(deps.commands.qoder, deps.runner),
          createCursorAdapter(deps.commands.cursor, deps.runner),
        ],
        requirement,
        notes,
        skillBody: skill.body,
        store: deps.store,
        clock: deps.clock,
        workspaceRoot: deps.workspaceRoot,
        artifacts: createArtifactStore(deps.workspaceRoot),
      });
    },
  };
}
