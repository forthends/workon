import { afterEach, describe, expect, it } from 'vitest';
import { createDelivery } from '../src/delivery.js';
import { createHttpServer } from '../src/http.js';
import { testStore } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const discover = async () => [
  { id: 'qoder' as const, command: 'qoder', online: true },
  { id: 'cursor' as const, command: 'agent', online: true },
];

function runningAttempt(store: ReturnType<typeof testStore>['store'], requirementId: string) {
  store.insertAttempt({
    requirementId,
    n: 1,
    clientId: 'qoder',
    status: 'running',
    pid: null,
    runDir: '/tmp/run',
    error: null,
    startedAt: '2026-10-24T00:00:03.000Z',
    finishedAt: null,
  });
}

async function withServer<T>(handler: (base: string, ctx: ReturnType<typeof testStore> & { delivery: ReturnType<typeof createDelivery> }) => Promise<T>) {
  const ctx = testStore();
  cleanups.push(ctx.cleanup);
  const delivery = createDelivery({ store: ctx.store, clock: ctx.clock, notify: () => undefined });
  const server = createHttpServer({
    delivery,
    discover,
    listInbox: () => ctx.store.listInbox(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await handler(base, { ...ctx, delivery });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('http', () => {
  it('submits and validates requirements', async () => {
    await withServer(async (base) => {
      const created = await fetch(`${base}/requirements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ' 导出 ' }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ status: 'queued' });

      const blank = await fetch(`${base}/requirements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ' ' }),
      });
      expect(blank.status).toBe(400);
      expect(await blank.json()).toMatchObject({ error: 'invalid' });
    });
  });

  it('accepts once and conflicts on the second accept', async () => {
    await withServer(async (base, { delivery, store }) => {
      const created = delivery.submit('需求');
      delivery.claimNext();
      runningAttempt(store, created.id);
      const key = `requirements/${created.id}/attempts/1/prd.md`;
      delivery.onReport(created.id, {
        outcome: 'completed',
        winningAttempt: 1,
        clientId: 'qoder',
        artifact: { key, url: 'file:///tmp/prd.md' },
        attempts: [],
      });

      const accepted = await fetch(`${base}/requirements/${created.id}/accept`, { method: 'POST' });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ status: 'accepted', artifactKey: key });

      const again = await fetch(`${base}/requirements/${created.id}/accept`, { method: 'POST' });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ status: 'accepted' });
    });
  });

  it('returns not found for an unknown id', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/requirements/req_missing/accept`, { method: 'POST' });
      expect(response.status).toBe(404);
    });
  });

  it('lists requirements without notes', async () => {
    await withServer(async (base, { delivery, clock }) => {
      const first = delivery.submit('第一');
      clock.advance(1000);
      const second = delivery.submit('第二');

      const response = await fetch(`${base}/requirements`);
      expect(response.status).toBe(200);
      const items = (await response.json()) as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([first.id, second.id]);
      for (const item of items) {
        expect(item).not.toHaveProperty('notes');
      }
    });
  });

  it('returns discovered clients', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/clients`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ clients: await discover() });
    });
  });
});
