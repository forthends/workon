import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkonError } from '../src/errors.js';
import { sequentialIds } from '../src/ids.js';
import { openStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'workon-store-'));
  dirs.push(dir);
  return openStore(path.join(dir, 'workon.sqlite'), sequentialIds());
}

describe('store', () => {
  it('lists requirements by created time and then id', () => {
    const store = newStore();
    const later = store.insertRequirement({ text: '后', now: '2026-10-24T00:00:02.000Z' });
    const earlier = store.insertRequirement({ text: '先', now: '2026-10-24T00:00:01.000Z' });
    expect(store.listRequirements().map((item) => item.id)).toEqual([earlier.id, later.id]);
    expect(store.oldestQueued()?.id).toBe(earlier.id);
    store.close();
  });

  it('rejects an update from the wrong status and rolls back the transaction', () => {
    const store = newStore();
    const req = store.insertRequirement({ text: '需求', now: '2026-10-24T00:00:01.000Z' });
    expect(() =>
      store.transaction(() => {
        store.insertNote({ requirementId: req.id, kind: 'reject', body: '不行', now: '2026-10-24T00:00:02.000Z' });
        store.updateRequirement(req.id, 'awaiting_acceptance', { status: 'queued', updatedAt: '2026-10-24T00:00:02.000Z' });
      }),
    ).toThrow(WorkonError);
    expect(store.listNotes(req.id)).toEqual([]);
    expect(store.getRequirement(req.id)?.status).toBe('queued');
    store.close();
  });

  it('numbers attempts and returns the latest artifact', () => {
    const store = newStore();
    const req = store.insertRequirement({ text: '需求', now: '2026-10-24T00:00:01.000Z' });
    expect(store.nextAttemptN(req.id)).toBe(1);
    store.insertAttempt({
      requirementId: req.id,
      n: 1,
      clientId: 'qoder',
      status: 'running',
      pid: null,
      runDir: '/tmp/run',
      error: null,
      startedAt: '2026-10-24T00:00:02.000Z',
      finishedAt: null,
    });
    expect(store.nextAttemptN(req.id)).toBe(2);
    store.insertArtifact({
      requirementId: req.id,
      attemptN: 1,
      key: `requirements/${req.id}/attempts/1/prd.md`,
      url: 'file:///tmp/prd.md',
      now: '2026-10-24T00:00:03.000Z',
    });
    expect(store.latestArtifact(req.id)?.attemptN).toBe(1);
    store.close();
  });
});
