import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRunner } from '../src/adapters.js';
import { manualClock } from '../src/clock.js';
import { createDelivery, type Delivery } from '../src/delivery.js';
import { runDaemon } from '../src/daemon.js';
import { createHttpServer } from '../src/http.js';
import { sequentialIds } from '../src/ids.js';
import { createProductRole } from '../src/product-role.js';
import { SKILL_TEMPLATE } from '../src/skills.js';
import { openStore } from '../src/store.js';
import type { RequirementDetail } from '../src/types.js';
import { createWake } from '../src/wake.js';
import { tempDir } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function writeCompleted(taskDir: string, body = '# PRD\n') {
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(taskDir, 'artifacts', 'prd.md'), body, 'utf8');
  writeFileSync(path.join(taskDir, 'report.json'), JSON.stringify({ outcome: 'completed' }), 'utf8');
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

async function pollRequirement(
  base: string,
  id: string,
  predicate: (detail: RequirementDetail) => boolean,
  timeoutMs = 5_000,
): Promise<RequirementDetail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/requirements/${id}`);
    const detail = (await response.json()) as RequirementDetail;
    if (predicate(detail)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for requirement ${id}`);
}

async function startTestDaemon(runner: CommandRunner) {
  const { dir, cleanup: rmDir } = tempDir('workon-daemon-');
  const skillPath = path.join(dir, 'skills', 'workon-prd', 'SKILL.md');
  mkdirSync(path.dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, SKILL_TEMPLATE, 'utf8');
  mkdirSync(path.join(dir, 'knowledge'), { recursive: true });

  const store = openStore(path.join(dir, 'workon.sqlite'), sequentialIds());
  const clock = manualClock();
  const wake = createWake();
  const baseDelivery = createDelivery({ store, clock, notify: () => undefined });
  const delivery = wrapDeliveryWithWake(baseDelivery, wake);

  const role = createProductRole({
    commands: { qoder: 'qoder', cursor: 'agent' },
    runner,
    store,
    clock,
    workspaceRoot: dir,
  });

  const abort = new AbortController();
  const daemonPromise = runDaemon({
    delivery,
    role,
    recover: async () => undefined,
    wake,
    signal: abort.signal,
  });

  const server = createHttpServer({
    delivery,
    discover: async () => [
      { id: 'qoder', command: 'qoder', online: true },
      { id: 'cursor', command: 'agent', online: false },
    ],
    listInbox: () => store.listInbox(),
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected port');
  const base = `http://127.0.0.1:${address.port}`;

  cleanups.push(async () => {
    abort.abort();
    wake.wake();
    await daemonPromise;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    store.close();
    rmDir();
  });

  return { base, store };
}

describe('runDaemon integration', () => {
  it('completes submit → accept with artifact on disk', async () => {
    const runner: CommandRunner = {
      probe: async (command) => command === 'qoder',
      run: async ({ cwd }) => {
        writeCompleted(cwd);
        return { exitCode: 0, timedOut: false, stdout: '' };
      },
    };

    const { base } = await startTestDaemon(runner);

    const created = await fetch(`${base}/requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '导出报表' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await pollRequirement(base, id, (detail) => detail.status === 'awaiting_acceptance');

    const accepted = await fetch(`${base}/requirements/${id}/accept`, { method: 'POST' });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { status: string; artifactKey: string };
    expect(body.status).toBe('accepted');
    expect(body.artifactKey).toMatch(/^requirements\//);

    const detail = await pollRequirement(base, id, (d) => d.status === 'accepted');
    const artifactUrl = detail.artifacts[0]?.url;
    expect(artifactUrl).toBeTruthy();
    const artifactPath = fileURLToPath(artifactUrl!);
    expect(existsSync(artifactPath)).toBe(true);
  });

  it('rejects and feeds comment into the next TASK.md', async () => {
    const taskMdReads: string[] = [];
    const runner: CommandRunner = {
      probe: async (command) => command === 'qoder',
      run: async ({ cwd }) => {
        taskMdReads.push(readFileSync(path.join(cwd, 'TASK.md'), 'utf8'));
        writeCompleted(cwd);
        return { exitCode: 0, timedOut: false, stdout: '' };
      },
    };

    const { base } = await startTestDaemon(runner);
    const rejectComment = '请补充边界条件 REJECT_MARKER_42';

    const created = await fetch(`${base}/requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '需求一' }),
    });
    const { id } = (await created.json()) as { id: string };

    await pollRequirement(base, id, (detail) => detail.status === 'awaiting_acceptance');

    const rejected = await fetch(`${base}/requirements/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: rejectComment }),
    });
    expect(rejected.status).toBe(200);
    expect((await rejected.json()) as { status: string }).toEqual({ status: 'queued' });

    await pollRequirement(base, id, (detail) => detail.status === 'awaiting_acceptance');
    expect(taskMdReads.length).toBeGreaterThanOrEqual(2);
    expect(taskMdReads[1]).toContain(`- 退回：${rejectComment}`);
  });

  it('processes one requirement at a time', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let runs = 0;

    const runner: CommandRunner = {
      probe: async (command) => command === 'qoder',
      run: async ({ cwd }) => {
        runs += 1;
        if (runs === 1) {
          await firstGate;
        }
        writeCompleted(cwd);
        return { exitCode: 0, timedOut: false, stdout: '' };
      },
    };

    const { base } = await startTestDaemon(runner);

    const first = await fetch(`${base}/requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '第一条' }),
    });
    const firstId = ((await first.json()) as { id: string }).id;

    await pollRequirement(base, firstId, (detail) => detail.status === 'in_progress');

    const second = await fetch(`${base}/requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '第二条' }),
    });
    const secondId = ((await second.json()) as { id: string }).id;

    const secondWhileBlocked = await fetch(`${base}/requirements/${secondId}`);
    expect(((await secondWhileBlocked.json()) as RequirementDetail).status).toBe('queued');

    releaseFirst();

    await pollRequirement(
      base,
      secondId,
      (detail) => detail.status !== 'queued',
      5_000,
    );
  });
});
