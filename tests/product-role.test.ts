import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../src/adapters.js';
import { createProductRole } from '../src/product-role.js';
import { SKILL_TEMPLATE } from '../src/skills.js';
import { testStore } from './helpers.js';

const cleanups: Array<() => void> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspaceRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workon-role-ws-'));
  dirs.push(dir);
  const skillPath = path.join(dir, 'skills', 'workon-prd', 'SKILL.md');
  mkdirSync(path.dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, SKILL_TEMPLATE, 'utf8');
  mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  return dir;
}

function writeCompleted(taskDir: string) {
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(taskDir, 'artifacts', 'prd.md'), '# PRD');
  writeFileSync(path.join(taskDir, 'report.json'), JSON.stringify({ outcome: 'completed', reason: '' }));
}

describe('createProductRole', () => {
  it('writes reject feedback into TASK.md and mounts the workspace skill', async () => {
    const { store, cleanup, clock } = testStore();
    cleanups.push(cleanup);
    const ws = workspaceRoot();
    const stamp = '2026-10-24T00:00:00.000Z';
    const req = store.insertRequirement({ text: '导出报表', now: stamp });
    store.insertNote({ requirementId: req.id, kind: 'reject', body: '意见', now: stamp });
    store.updateRequirement(req.id, 'queued', { status: 'in_progress', route: 'prd', updatedAt: stamp });

    let capturedTaskMd = '';
    const runner: CommandRunner = {
      probe: vi.fn(async () => true),
      run: vi.fn(async ({ cwd }) => {
        capturedTaskMd = readFileSync(path.join(cwd, 'TASK.md'), 'utf8');
        writeCompleted(cwd);
        return { exitCode: 0, timedOut: false, stdout: '' };
      }),
    };

    const role = createProductRole({
      commands: { qoder: 'qoder-bin', cursor: 'cursor-bin' },
      runner,
      store,
      clock,
      workspaceRoot: ws,
    });

    const report = await role.handle({
      requirementId: req.id,
      route: 'prd',
      role: 'product',
      skillId: 'workon-prd',
      size: 'unclassified',
    });

    expect(report.outcome).toBe('completed');
    expect(capturedTaskMd).toContain('- 退回：意见');
    const mounted = path.join(ws, 'runs', req.id, '1', '.qoder', 'skills', 'workon-prd', 'SKILL.md');
    expect(readFileSync(mounted, 'utf8')).toBe(SKILL_TEMPLATE);
  });
});
