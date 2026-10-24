import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { SKILL_TEMPLATE } from '../src/skills.js';
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
});
