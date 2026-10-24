import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STDOUT_LIMIT } from '../src/constants.js';
import { createProcessRunner } from '../src/process-runner.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'workon-runner-'));
  dirs.push(dir);
  return dir;
}

describe('process-runner', () => {
  const runner = createProcessRunner();

  it('probe succeeds for node and fails for missing command', async () => {
    expect(await runner.probe('node', 5000)).toBe(true);
    expect(await runner.probe('workon-missing-bin', 500)).toBe(false);
  });

  it('run times out and kills the child process', async () => {
    const cwd = newTmp();
    let pid = 0;
    const result = await runner.run({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd,
      timeoutMs: 200,
      onPid: (p) => {
        pid = p;
      },
    });

    expect(result.timedOut).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('truncates stdout to STDOUT_LIMIT bytes', async () => {
    const cwd = newTmp();
    const result = await runner.run({
      command: 'node',
      args: ['-e', "process.stdout.write('x'.repeat(1_200_000))"],
      cwd,
      timeoutMs: 30_000,
      onPid: () => {},
    });

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(STDOUT_LIMIT);
  });
});
