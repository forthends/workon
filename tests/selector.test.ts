import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientAdapter } from '../src/adapters.js';
import { createArtifactStore } from '../src/artifacts.js';
import { runWithFallback } from '../src/selector.js';
import type { Requirement } from '../src/types.js';
import { testStore } from './helpers.js';

const cleanups: Array<() => void> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspaceRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workon-ws-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  return dir;
}

function requirement(id: string, text = '需求'): Requirement {
  const stamp = '2026-10-24T00:00:00.000Z';
  return {
    id,
    text,
    status: 'in_progress',
    size: 'unclassified',
    route: 'prd',
    needsHumanClass: null,
    acceptedArtifactId: null,
    consecutiveInterruptions: 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function writeCompleted(taskDir: string, prd = '# PRD\n') {
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(taskDir, 'artifacts', 'prd.md'), prd);
  writeFileSync(path.join(taskDir, 'report.json'), JSON.stringify({ outcome: 'completed', reason: '' }));
}

function writeBlocked(taskDir: string, reason: string) {
  writeFileSync(path.join(taskDir, 'report.json'), JSON.stringify({ outcome: 'blocked', reason }));
}

function fakeAdapter(
  id: 'qoder' | 'cursor',
  opts: {
    discover?: () => Promise<boolean>;
    run?: ClientAdapter['run'];
  } = {},
): ClientAdapter {
  const runCounts = { value: 0 };
  const run =
    opts.run ??
    vi.fn(async ({ taskDir }: { taskDir: string }) => {
      runCounts.value += 1;
      writeCompleted(taskDir);
      return { exitCode: 0, timedOut: false, stdout: '' };
    });
  return {
    id,
    command: `${id}-cmd`,
    discover: opts.discover ?? (async () => true),
    mountRelative: () => (id === 'qoder' ? '.qoder/skills/workon-prd/SKILL.md' : '.cursor/skills/workon-prd/SKILL.md'),
    run: typeof run === 'function' && 'mock' in run ? run : vi.fn(run),
  };
}

describe('runWithFallback', () => {
  it('completes on qoder without running cursor', async () => {
    const { store, cleanup, clock } = testStore();
    cleanups.push(cleanup);
    const ws = workspaceRoot();
    const req = store.insertRequirement({ text: '导出', now: '2026-10-24T00:00:00.000Z' });
    const cursorRun = vi.fn();
    const qoderRun = vi.fn(async ({ taskDir }) => {
      writeCompleted(taskDir);
      return { exitCode: 0, timedOut: false, stdout: 'done' };
    });
    const artifacts = createArtifactStore(ws);

    const report = await runWithFallback({
      adapters: [
        fakeAdapter('qoder', { run: qoderRun }),
        fakeAdapter('cursor', { run: cursorRun }),
      ],
      requirement: requirement(req.id, req.text),
      notes: [],
      skillBody: 'skill',
      store,
      clock,
      workspaceRoot: ws,
      artifacts,
    });

    expect(report.outcome).toBe('completed');
    expect(report.clientId).toBe('qoder');
    expect(report.winningAttempt).toBe(1);
    expect(report.artifact?.key.endsWith('/attempts/1/prd.md')).toBe(true);
    expect(cursorRun).not.toHaveBeenCalled();
    expect(store.listAttempts(req.id)[0]).toMatchObject({ n: 1, status: 'running', clientId: 'qoder' });
    expect(
      store.listEvents(req.id).some((e) => e.type === 'attempt.finished' && (e.payload as { n: number }).n === 1),
    ).toBe(false);
    const taskDir = path.join(ws, 'runs', req.id, '1');
    expect(readFileSync(path.join(taskDir, 'stdout.log'), 'utf8')).toBe('done');
  });

  it('falls back to cursor when qoder is offline and reports blocked', async () => {
    const { store, cleanup, clock } = testStore();
    cleanups.push(cleanup);
    const ws = workspaceRoot();
    const req = store.insertRequirement({ text: '需求', now: '2026-10-24T00:00:00.000Z' });
    const cursorRun = vi.fn(async ({ taskDir }) => {
      writeBlocked(taskDir, '缺边界');
      return { exitCode: 0, timedOut: false, stdout: '' };
    });

    const report = await runWithFallback({
      adapters: [
        fakeAdapter('qoder', { discover: async () => false }),
        fakeAdapter('cursor', { run: cursorRun }),
      ],
      requirement: requirement(req.id),
      notes: [],
      skillBody: 'skill',
      store,
      clock,
      workspaceRoot: ws,
      artifacts: createArtifactStore(ws),
    });

    expect(report.outcome).toBe('blocked');
    expect(report.needsHumanClass).toBe('content');
    expect(report.reason).toBe('缺边界');
    expect(report.winningAttempt).toBe(2);
    expect(store.listAttempts(req.id)).toMatchObject([
      { n: 1, status: 'offline', clientId: 'qoder', error: '离线' },
      { n: 2, status: 'running', clientId: 'cursor' },
    ]);
    expect(
      store.listEvents(req.id).filter((e) => e.type === 'attempt.finished').map((e) => e.payload),
    ).toEqual([{ n: 1, status: 'offline' }]);
  });

  it('falls back when qoder fails without report.json', async () => {
    const { store, cleanup, clock } = testStore();
    cleanups.push(cleanup);
    const ws = workspaceRoot();
    const req = store.insertRequirement({ text: '需求', now: '2026-10-24T00:00:00.000Z' });
    const qoderRun = vi.fn(async () => ({ exitCode: 1, timedOut: false, stdout: '' }));
    const cursorRun = vi.fn(async ({ taskDir }) => {
      writeCompleted(taskDir);
      return { exitCode: 0, timedOut: false, stdout: '' };
    });

    const report = await runWithFallback({
      adapters: [fakeAdapter('qoder', { run: qoderRun }), fakeAdapter('cursor', { run: cursorRun })],
      requirement: requirement(req.id),
      notes: [],
      skillBody: 'skill',
      store,
      clock,
      workspaceRoot: ws,
      artifacts: createArtifactStore(ws),
    });

    expect(report.outcome).toBe('completed');
    expect(report.clientId).toBe('cursor');
    expect(report.winningAttempt).toBe(2);
    expect(store.listAttempts(req.id)[0]?.status).toBe('failed');
    expect(
      store.listEvents(req.id).filter((e) => e.type === 'attempt.finished').map((e) => e.payload),
    ).toContainEqual({ n: 1, status: 'failed' });
  });

  it('reports client failure when all adapters are offline', async () => {
    const { store, cleanup, clock } = testStore();
    cleanups.push(cleanup);
    const ws = workspaceRoot();
    const req = store.insertRequirement({ text: '需求', now: '2026-10-24T00:00:00.000Z' });

    const report = await runWithFallback({
      adapters: [
        fakeAdapter('qoder', { discover: async () => false }),
        fakeAdapter('cursor', { discover: async () => false }),
      ],
      requirement: requirement(req.id),
      notes: [],
      skillBody: 'skill',
      store,
      clock,
      workspaceRoot: ws,
      artifacts: createArtifactStore(ws),
    });

    expect(report).toMatchObject({
      outcome: 'failed',
      needsHumanClass: 'clients',
      reason: '客户端未能完成，等待 retry',
    });
    expect(existsSync(path.join(ws, 'runs', req.id))).toBe(false);
  });
});
