import { describe, expect, it, vi } from 'vitest';
import { buildPrompt } from '../src/prompt.js';
import {
  createCursorAdapter,
  createQoderAdapter,
  type CommandRunner,
} from '../src/adapters.js';

function fakeRunner(overrides: Partial<CommandRunner> = {}): CommandRunner {
  return {
    probe: vi.fn(async () => true),
    run: vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: '' })),
    ...overrides,
  };
}

describe('adapters', () => {
  it('buildPrompt includes skill path and task references', () => {
    const prompt = buildPrompt('/tmp/SKILL.md');
    expect(prompt).toContain('/workon-prd');
    expect(prompt).toContain('/tmp/SKILL.md');
    expect(prompt).toContain('TASK.md');
    expect(prompt).toContain('knowledge/');
  });

  it('qoder mountRelative and run args', async () => {
    const runner = fakeRunner();
    const adapter = createQoderAdapter('qoder-cli', runner);
    expect(adapter.mountRelative()).toBe('.qoder/skills/workon-prd/SKILL.md');

    const taskDir = '/tmp/task';
    const prompt = 'do work';
    await adapter.run({
      taskDir,
      prompt,
      timeoutMs: 60_000,
      onPid: () => {},
    });

    expect(runner.run).toHaveBeenCalledWith({
      command: 'qoder-cli',
      args: ['-p', '--permission-mode', 'accept_edits', '-w', taskDir, '-o', 'json', prompt],
      cwd: taskDir,
      timeoutMs: 60_000,
      onPid: expect.any(Function),
    });
  });

  it('cursor mountRelative and run args', async () => {
    const runner = fakeRunner();
    const adapter = createCursorAdapter('cursor-agent', runner);
    expect(adapter.mountRelative()).toBe('.cursor/skills/workon-prd/SKILL.md');

    const taskDir = '/tmp/cursor-task';
    const prompt = 'cursor prompt';
    await adapter.run({
      taskDir,
      prompt,
      timeoutMs: 30_000,
      onPid: () => {},
    });

    expect(runner.run).toHaveBeenCalledWith({
      command: 'cursor-agent',
      args: [
        '-p',
        '--force',
        '--trust',
        '--output-format',
        'json',
        '--workspace',
        taskDir,
        prompt,
      ],
      cwd: taskDir,
      timeoutMs: 30_000,
      onPid: expect.any(Function),
    });
  });

  it('discover uses probe with 5000ms timeout', async () => {
    const probe = vi.fn(async () => false);
    const runner = fakeRunner({ probe });
    const adapter = createQoderAdapter('qoder-cli', runner);
    const ok = await adapter.discover();
    expect(ok).toBe(false);
    expect(probe).toHaveBeenCalledWith('qoder-cli', 5000);
  });
});
