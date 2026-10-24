import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manualClock } from '../src/clock.js';
import { sequentialIds } from '../src/ids.js';
import { openStore, type Store } from '../src/store.js';

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testStore(): { store: Store; cleanup: () => void; clock: ReturnType<typeof manualClock> } {
  const { dir, cleanup } = tempDir('workon-db-');
  return { store: openStore(path.join(dir, 'workon.sqlite'), sequentialIds()), cleanup, clock: manualClock() };
}
