import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { initWorkspace } from './init-workspace.js';

export interface CliIo {
  cwd: string;
  stdout: string[];
  stderr: string[];
  fetch: typeof fetch;
}

function workspaceRoot(cwd: string): string {
  return path.join(cwd, '.workon');
}

function configPath(cwd: string): string {
  return path.join(workspaceRoot(cwd), 'config.json');
}

async function apiFetch(
  io: CliIo,
  urlPath: string,
  init?: RequestInit,
): Promise<{ ok: true; data: unknown } | { ok: false; code: number }> {
  let response: Response;
  try {
    response = await io.fetch(urlPath, init);
  } catch {
    io.stderr.push('常驻进程未启动');
    return { ok: false, code: 1 };
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && data !== null && 'message' in data
        ? String((data as { message: unknown }).message)
        : String(data);
    io.stderr.push(message);
    return { ok: false, code: 1 };
  }

  io.stdout.push(JSON.stringify(data, null, 2));
  return { ok: true, data };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;

  if (!command) {
    io.stderr.push('未知命令');
    return 1;
  }

  if (command === 'init') {
    try {
      initWorkspace(io.cwd);
    } catch (error) {
      if (error instanceof Error && error.message === '工作区已存在') {
        io.stderr.push('工作区已存在');
        return 1;
      }
      throw error;
    }
    return 0;
  }

  if (!existsSync(configPath(io.cwd))) {
    io.stderr.push('需要先 init');
    return 1;
  }

  const config = loadConfig(workspaceRoot(io.cwd));
  const base = `http://127.0.0.1:${config.port}`;

  switch (command) {
    case 'submit': {
      if (rest.length === 0) {
        io.stderr.push('参数不足');
        return 1;
      }
      const text = rest.join(' ');
      const result = await apiFetch(io, `${base}/requirements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return result.ok ? 0 : result.code;
    }
    case 'status': {
      const id = rest[0];
      const url = id ? `${base}/requirements/${id}` : `${base}/requirements`;
      const result = await apiFetch(io, url);
      return result.ok ? 0 : result.code;
    }
    case 'accept': {
      const id = rest[0];
      if (!id) {
        io.stderr.push('参数不足');
        return 1;
      }
      const result = await apiFetch(io, `${base}/requirements/${id}/accept`, { method: 'POST' });
      return result.ok ? 0 : result.code;
    }
    case 'reject': {
      const id = rest[0];
      if (!id || rest.length < 2) {
        io.stderr.push('参数不足');
        return 1;
      }
      const comment = rest.slice(1).join(' ');
      const result = await apiFetch(io, `${base}/requirements/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      });
      return result.ok ? 0 : result.code;
    }
    case 'supplement': {
      const id = rest[0];
      if (!id || rest.length < 2) {
        io.stderr.push('参数不足');
        return 1;
      }
      const text = rest.slice(1).join(' ');
      const result = await apiFetch(io, `${base}/requirements/${id}/supplement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return result.ok ? 0 : result.code;
    }
    case 'retry': {
      const id = rest[0];
      if (!id) {
        io.stderr.push('参数不足');
        return 1;
      }
      const result = await apiFetch(io, `${base}/requirements/${id}/retry`, { method: 'POST' });
      return result.ok ? 0 : result.code;
    }
    case 'inbox': {
      const result = await apiFetch(io, `${base}/inbox`);
      return result.ok ? 0 : result.code;
    }
    case 'clients': {
      const result = await apiFetch(io, `${base}/clients`);
      return result.ok ? 0 : result.code;
    }
    default:
      io.stderr.push('未知命令');
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout,
    stderr,
    fetch: globalThis.fetch,
  }).then((code) => {
    for (const line of stdout) console.log(line);
    for (const line of stderr) console.error(line);
    process.exit(code);
  });
}
