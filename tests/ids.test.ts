import { describe, expect, it } from 'vitest';
import { createIds, sequentialIds } from '../src/ids.js';
import { manualClock } from '../src/clock.js';
import { CLIENT_PRIORITY, RUN_TIMEOUT_MS } from '../src/constants.js';

describe('ids and clock', () => {
  it('creates a random id with the required prefix and length', () => {
    const id = createIds().next('req');
    expect(id).toMatch(/^req_[0-9a-f]{12}$/);
  });

  it('creates sequential ids for tests', () => {
    const ids = sequentialIds();
    expect(ids.next('note')).toBe('note_000000000001');
    expect(ids.next('note')).toBe('note_000000000002');
  });

  it('advances the manual clock', () => {
    const clock = manualClock('2026-10-24T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-10-24T00:00:00.000Z');
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-10-24T00:00:01.000Z');
  });

  it('locks the client priority and the run timeout', () => {
    expect(CLIENT_PRIORITY).toEqual(['qoder', 'cursor']);
    expect(RUN_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });
});
