import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, startDaemon } from '../src/cli.js';
import { createIds } from '../src/ids.js';
import { SKILL_TEMPLATE } from '../src/skills.js';
import { openStore } from '../src/store.js';
import { tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeIo(cwd: string, fetchImpl: typeof fetch = globalThis.fetch) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    cwd,
    stdout,
    stderr,
    fetch: fetchImpl,
  };
  return { io, stdout, stderr };
}

describe('cli', () => {
  it('init creates workspace; duplicate init and missing workspace errors', async () => {
    const { dir, cleanup } = tempDir('workon-cli-');
    cleanups.push(cleanup);
    const { io, stderr } = makeIo(dir);

    const code1 = await runCli(['init'], io);
    expect(code1).toBe(0);

    const configPath = path.join(dir, '.workon', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config).toEqual({
      port: 4787,
      clients: { qoder: 'qoder', cursor: 'agent' },
    });

    const skillPath = path.join(dir, '.workon', 'skills', 'workon-prd', 'SKILL.md');
    expect(readFileSync(skillPath, 'utf8')).toBe(SKILL_TEMPLATE);
    expect(existsSync(path.join(dir, '.workon', 'workon.sqlite'))).toBe(true);

    const code2 = await runCli(['init'], io);
    expect(code2).toBe(1);
    expect(stderr.some((line) => line.includes('工作区已存在'))).toBe(true);
  });

  it('requires init before other commands', async () => {
    const { dir, cleanup } = tempDir('workon-cli-');
    cleanups.push(cleanup);
    const { io, stderr } = makeIo(dir);

    const code = await runCli(['submit', 'hello'], io);
    expect(code).toBe(1);
    expect(stderr.some((line) => line.includes('需要先 init'))).toBe(true);
  });

  it('reports daemon not running when fetch fails', async () => {
    const { dir, cleanup } = tempDir('workon-cli-');
    cleanups.push(cleanup);
    const { io: initIo } = makeIo(dir);
    await runCli(['init'], initIo);

    const fetchImpl = async () => {
      const error = new Error('connect ECONNREFUSED');
      (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      throw error;
    };
    const { io, stderr } = makeIo(dir, fetchImpl as typeof fetch);

    const code = await runCli(['submit', '导出'], io);
    expect(code).toBe(1);
    expect(stderr.some((line) => line.includes('常驻进程未启动'))).toBe(true);
  });

  it('submit posts joined text and prints JSON on success', async () => {
    const { dir, cleanup } = tempDir('workon-cli-');
    cleanups.push(cleanup);
    const { io: initIo } = makeIo(dir);
    await runCli(['init'], initIo);

    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u === 'http://127.0.0.1:4787/requirements' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ text: '导出 报表' });
        return new Response(JSON.stringify({ id: 'req_000000000001', status: 'queued' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    };

    const { io, stdout } = makeIo(dir, fetchImpl as typeof fetch);
    const code = await runCli(['submit', '导出', '报表'], io);
    expect(code).toBe(0);
    expect(stdout).toEqual([
      JSON.stringify({ id: 'req_000000000001', status: 'queued' }, null, 2),
    ]);
  });

  it('startDaemon rejects when the configured port is already in use', async () => {
    const { dir, cleanup } = tempDir('workon-cli-port-');
    cleanups.push(cleanup);
    const { io: initIo } = makeIo(dir);
    await runCli(['init'], initIo);

    const placeholder = createServer();
    await new Promise<void>((resolve) => placeholder.listen(0, '127.0.0.1', resolve));
    const address = placeholder.address();
    if (!address || typeof address === 'string') throw new Error('expected port');

    const configPath = path.join(dir, '.workon', 'config.json');
    writeFileSync(configPath, `${JSON.stringify({ port: address.port, clients: { qoder: 'qoder', cursor: 'agent' } }, null, 2)}\n`, 'utf8');

    await expect(
      startDaemon(dir, { notify: () => ({ notify() {} }) }),
    ).rejects.toThrow(/端口已被占用/);

    await new Promise<void>((resolve, reject) => placeholder.close((error) => (error ? reject(error) : resolve())));
  });

  it('starts when the recorded pid is alive but is not a process group', async () => {
    const { dir, cleanup } = tempDir('workon-cli-kill-');
    cleanups.push(cleanup);
    await runCli(['init'], makeIo(dir).io);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    cleanups.push(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve());
    });
    const port = await reservePort();
    writeFileSync(
      path.join(dir, '.workon', 'config.json'),
      `${JSON.stringify({ port, clients: { qoder: 'workon-missing-qoder', cursor: 'workon-missing-agent' } }, null, 2)}\n`,
      'utf8',
    );
    seedInterrupted(dir, child.pid ?? 0);

    const daemon = await startDaemon(dir, { notify: () => ({ notify() {} }) });
    await daemon.close();

    expect(child.exitCode).toBeNull();
    const store = openStore(path.join(dir, '.workon', 'workon.sqlite'), createIds());
    const status = store.getRequirement(store.listRequirements()[0]?.id ?? '')?.status;
    store.close();
    expect(['queued', 'in_progress', 'needs_human']).toContain(status);
  });

  it('does not listen when recovery fails', async () => {
    const { dir, cleanup } = tempDir('workon-cli-recover-');
    cleanups.push(cleanup);
    await runCli(['init'], makeIo(dir).io);
    const port = await reservePort();
    writeFileSync(
      path.join(dir, '.workon', 'config.json'),
      `${JSON.stringify({ port, clients: { qoder: 'qoder', cursor: 'agent' } }, null, 2)}\n`,
      'utf8',
    );
    seedInterrupted(dir, 1);

    await expect(
      startDaemon(dir, {
        notify: () => ({ notify() {} }),
        killer: {
          isAlive: () => true,
          killGroup: async () => {
            throw new Error('杀进程失败');
          },
        },
      }),
    ).rejects.toThrow('杀进程失败');

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  });
});

async function reservePort(): Promise<number> {
  const placeholder = createServer();
  await new Promise<void>((resolve) => placeholder.listen(0, '127.0.0.1', resolve));
  const address = placeholder.address();
  if (!address || typeof address === 'string') throw new Error('expected port');
  await new Promise<void>((resolve, reject) => placeholder.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function seedInterrupted(dir: string, pid: number): void {
  const store = openStore(path.join(dir, '.workon', 'workon.sqlite'), createIds());
  const stamp = new Date().toISOString();
  const created = store.insertRequirement({ text: '中断的需求', now: stamp });
  store.updateRequirement(created.id, 'queued', { status: 'in_progress', updatedAt: stamp });
  store.insertAttempt({
    requirementId: created.id,
    n: 1,
    clientId: 'qoder',
    status: 'running',
    pid,
    runDir: null,
    error: null,
    startedAt: stamp,
    finishedAt: null,
  });
  store.close();
}
