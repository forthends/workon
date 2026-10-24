import { spawn } from 'node:child_process';
import { KILL_GRACE_MS, STDOUT_LIMIT } from './constants.js';

export interface CommandRunner {
  probe(command: string, timeoutMs: number): Promise<boolean>;
  run(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    onPid: (pid: number) => void;
  }): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }>;
}

export function createProcessRunner(): CommandRunner {
  return {
    probe(command, timeoutMs) {
      return new Promise((resolve) => {
        const child = spawn(command, ['--version'], {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        });

        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };

        const timer = setTimeout(() => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              // already gone
            }
          }
          try {
            child.kill();
          } catch {
            // already gone
          }
          finish(false);
        }, timeoutMs);

        child.on('error', () => finish(false));
        child.on('exit', (code) => finish(code === 0));
      });
    },

    run({ command, args, cwd, timeoutMs, onPid }) {
      return new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (child.pid !== undefined) {
          onPid(child.pid);
        }

        const stdoutChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stdoutTruncated = false;

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdoutTruncated) return;
          const remaining = STDOUT_LIMIT - stdoutBytes;
          if (chunk.length <= remaining) {
            stdoutChunks.push(chunk);
            stdoutBytes += chunk.length;
          } else {
            if (remaining > 0) {
              stdoutChunks.push(chunk.subarray(0, remaining));
            }
            stdoutBytes = STDOUT_LIMIT;
            stdoutTruncated = true;
          }
        });

        child.stderr?.on('data', () => {});

        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          const stdout = Buffer.concat(stdoutChunks).toString('utf8');
          resolve({ exitCode, timedOut, stdout });
        };

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          const pid = child.pid;
          if (pid !== undefined) {
            try {
              process.kill(-pid, 'SIGTERM');
            } catch {
              // already gone
            }
            killTimer = setTimeout(() => {
              try {
                process.kill(-pid, 'SIGKILL');
              } catch {
                // already gone
              }
            }, KILL_GRACE_MS);
          }
        }, timeoutMs);

        child.on('error', () => finish(null));
        child.on('exit', (code) => finish(code));
      });
    },
  };
}
