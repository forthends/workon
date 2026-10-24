import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../src/artifacts.js';
import { tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('createArtifactStore', () => {
  it('writes PRD artifact and returns file URL ref', () => {
    const { dir, cleanup } = tempDir('workon-artifacts-');
    cleanups.push(cleanup);
    const store = createArtifactStore(dir);
    const ref = store.put('req_000000000001', 2, Buffer.from('# PRD'));
    expect(ref.key).toBe('requirements/req_000000000001/attempts/2/prd.md');
    expect(ref.url.startsWith('file://')).toBe(true);
    const content = readFileSync(fileURLToPath(ref.url), 'utf8');
    expect(content).toBe('# PRD');
  });
});
