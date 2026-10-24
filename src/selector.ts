import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClientAdapter } from './adapters.js';
import type { createArtifactStore } from './artifacts.js';
import type { Clock } from './clock.js';
import { RUN_TIMEOUT_MS, STDOUT_LIMIT } from './constants.js';
import { writeTaskMarkdown } from './context.js';
import { judgeAttempt } from './judge.js';
import { copyKnowledge } from './knowledge.js';
import { buildPrompt } from './prompt.js';
import type { Store } from './store.js';
import { mountSkill } from './skills.js';
import type { ExecutionReport, Note, Requirement } from './types.js';

function truncateStdout(stdout: string): string {
  const bytes = Buffer.from(stdout, 'utf8');
  if (bytes.length <= STDOUT_LIMIT) return stdout;
  return bytes.subarray(0, STDOUT_LIMIT).toString('utf8');
}

export async function runWithFallback(deps: {
  adapters: ClientAdapter[];
  requirement: Requirement;
  notes: Note[];
  skillBody: string;
  store: Store;
  clock: Clock;
  workspaceRoot: string;
  artifacts: ReturnType<typeof createArtifactStore>;
}): Promise<ExecutionReport> {
  const { adapters, requirement, notes, skillBody, store, clock, workspaceRoot, artifacts } = deps;
  const attemptRecords: ExecutionReport['attempts'] = [];
  const now = () => clock.now().toISOString();

  for (const adapter of adapters) {
    const n = store.nextAttemptN(requirement.id);
    const online = await adapter.discover();

    if (!online) {
      const stamp = now();
      store.insertAttempt({
        requirementId: requirement.id,
        n,
        clientId: adapter.id,
        status: 'offline',
        pid: null,
        runDir: null,
        error: '离线',
        startedAt: stamp,
        finishedAt: stamp,
      });
      store.insertEvent({
        requirementId: requirement.id,
        type: 'attempt.finished',
        payload: { n, status: 'offline' },
        now: stamp,
      });
      attemptRecords.push({ n, clientId: adapter.id, status: 'offline', error: '离线' });
      continue;
    }

    const taskDir = path.join(workspaceRoot, 'runs', requirement.id, String(n));
    mkdirSync(taskDir, { recursive: true });

    store.insertAttempt({
      requirementId: requirement.id,
      n,
      clientId: adapter.id,
      status: 'running',
      pid: null,
      runDir: taskDir,
      error: null,
      startedAt: now(),
      finishedAt: null,
    });

    writeTaskMarkdown(taskDir, { text: requirement.text, notes });
    copyKnowledge(path.join(workspaceRoot, 'knowledge'), path.join(taskDir, 'knowledge'));

    let mountedPath: string;
    try {
      mountedPath = mountSkill(taskDir, adapter.id, skillBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stamp = now();
      store.updateAttempt(requirement.id, n, { status: 'failed', error: message, finishedAt: stamp });
      store.insertEvent({
        requirementId: requirement.id,
        type: 'attempt.finished',
        payload: { n, status: 'failed' },
        now: stamp,
      });
      attemptRecords.push({ n, clientId: adapter.id, status: 'failed', error: message });
      continue;
    }

    const result = await adapter.run({
      taskDir,
      prompt: buildPrompt(mountedPath),
      timeoutMs: RUN_TIMEOUT_MS,
      onPid: (pid) => {
        store.updateAttempt(requirement.id, n, { pid });
      },
    });

    writeFileSync(path.join(taskDir, 'stdout.log'), truncateStdout(result.stdout), 'utf8');

    const judged = judgeAttempt(taskDir, { exitCode: result.exitCode, timedOut: result.timedOut });

    if (judged.status === 'completed') {
      const artifact = artifacts.put(requirement.id, n, readFileSync(judged.prdPath));
      attemptRecords.push({ n, clientId: adapter.id, status: 'running' });
      return {
        outcome: 'completed',
        clientId: adapter.id,
        winningAttempt: n,
        artifact,
        attempts: attemptRecords,
      };
    }

    if (judged.status === 'blocked') {
      attemptRecords.push({ n, clientId: adapter.id, status: 'running' });
      return {
        outcome: 'blocked',
        winningAttempt: n,
        needsHumanClass: 'content',
        reason: judged.reason,
        attempts: attemptRecords,
      };
    }

    const stamp = now();
    const terminalStatus = judged.status === 'timeout' ? 'timeout' : 'failed';
    const error = judged.error;
    store.updateAttempt(requirement.id, n, { status: terminalStatus, error, finishedAt: stamp });
    store.insertEvent({
      requirementId: requirement.id,
      type: 'attempt.finished',
      payload: { n, status: terminalStatus },
      now: stamp,
    });
    attemptRecords.push({ n, clientId: adapter.id, status: terminalStatus, error });
  }

  return {
    outcome: 'failed',
    needsHumanClass: 'clients',
    reason: '客户端未能完成，等待 retry',
    attempts: attemptRecords,
  };
}
