import { PROBE_TIMEOUT_MS } from './constants.js';
import type { CommandRunner } from './process-runner.js';
import type { ClientId } from './types.js';

export type { CommandRunner };

export type ClientAdapter = {
  id: ClientId;
  command: string;
  discover(): Promise<boolean>;
  mountRelative(): string;
  run(input: {
    taskDir: string;
    prompt: string;
    timeoutMs: number;
    onPid: (pid: number) => void;
  }): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }>;
};

export function createQoderAdapter(command: string, runner: CommandRunner): ClientAdapter {
  return {
    id: 'qoder',
    command,
    discover: () => runner.probe(command, PROBE_TIMEOUT_MS),
    mountRelative: () => '.qoder/skills/workon-prd/SKILL.md',
    run: ({ taskDir, prompt, timeoutMs, onPid }) =>
      runner.run({
        command,
        args: ['-p', '--permission-mode', 'accept_edits', '-w', taskDir, '-o', 'json', prompt],
        cwd: taskDir,
        timeoutMs,
        onPid,
      }),
  };
}

export function createCursorAdapter(command: string, runner: CommandRunner): ClientAdapter {
  return {
    id: 'cursor',
    command,
    discover: () => runner.probe(command, PROBE_TIMEOUT_MS),
    mountRelative: () => '.cursor/skills/workon-prd/SKILL.md',
    run: ({ taskDir, prompt, timeoutMs, onPid }) =>
      runner.run({
        command,
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
        timeoutMs,
        onPid,
      }),
  };
}
