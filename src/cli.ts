import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { PROBE_TIMEOUT_MS, KILL_GRACE_MS } from './constants.js';
import { createDelivery, type Delivery } from './delivery.js';
import { runDaemon } from './daemon.js';
import { createHttpServer } from './http.js';
import { createIds } from './ids.js';
import { initWorkspace } from './init-workspace.js';
import { createMacNotifier } from './notify.js';
import { createProcessRunner } from './process-runner.js';
import { createProductRole } from './product-role.js';
import { recoverInterrupted, type ProcessKiller } from './recovery.js';
import { openStore } from './store.js';
import { createWake } from './wake.js';

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

function wrapDeliveryWithWake(delivery: Delivery, wake: ReturnType<typeof createWake>): Delivery {
  return {
    ...delivery,
    submit(text) {
      const result = delivery.submit(text);
      wake.wake();
      return result;
    },
    reject(id, comment) {
      const result = delivery.reject(id, comment);
      wake.wake();
      return result;
    },
    supplement(id, text) {
      const result = delivery.supplement(id, text);
      wake.wake();
      return result;
    },
    retry(id) {
      const result = delivery.retry(id);
      wake.wake();
      return result;
    },
  };
}

function createProductionKiller(): ProcessKiller {
  return {
    isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async killGroup(pid: number): Promise<void> {
      process.kill(-pid, 'SIGTERM');
      await new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS));
      process.kill(-pid, 'SIGKILL');
    },
  };
}

export async function startDaemon(
  cwd: string,
  env?: { notify?: typeof createMacNotifier },
): Promise<{ close(): Promise<void> }> {
  const ws = workspaceRoot(cwd);
  const config = loadConfig(ws);
  const store = openStore(path.join(ws, 'workon.sqlite'), createIds());
  const clock = systemClock;
  const notifyFactory = env?.notify ?? createMacNotifier;
  const notifier = notifyFactory();
  const wake = createWake();
  const baseDelivery = createDelivery({ store, clock, notify: notifier.notify.bind(notifier) });
  const delivery = wrapDeliveryWithWake(baseDelivery, wake);
  const runner = createProcessRunner();
  const role = createProductRole({
    commands: config.clients,
    runner,
    store,
    clock,
    workspaceRoot: ws,
  });

  const server = createHttpServer({
    delivery,
    discover: async () => {
      const clients: Array<{ id: 'qoder' | 'cursor'; command: string; online: boolean }> = [];
      for (const id of ['qoder', 'cursor'] as const) {
        const command = config.clients[id];
        const online = await runner.probe(command, PROBE_TIMEOUT_MS);
        clients.push({ id, command, online });
      }
      return clients;
    },
    listInbox: () => store.listInbox(),
  });

  const abort = new AbortController();
  let daemonPromise: Promise<void> | undefined;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        store.close();
        reject(new Error('端口已被占用'));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  daemonPromise = runDaemon({
    delivery,
    role,
    recover: () =>
      recoverInterrupted({
        store,
        clock,
        killer: createProductionKiller(),
        notify: notifier.notify.bind(notifier),
      }),
    wake,
    signal: abort.signal,
  });

  return {
    async close() {
      abort.abort();
      wake.wake();
      await daemonPromise;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      store.close();
    },
  };
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

  if (command === 'start') {
    try {
      const handle = await startDaemon(io.cwd);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => {
          void handle.close().then(() => resolve());
        });
      });
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr.push(message);
      return 1;
    }
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
