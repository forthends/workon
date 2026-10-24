import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactRef } from './types.js';

export function createArtifactStore(workspaceRoot: string): { put(requirementId: string, attemptN: number, body: Buffer): ArtifactRef } {
  return {
    put(requirementId, attemptN, body) {
      const key = `requirements/${requirementId}/attempts/${attemptN}/prd.md`;
      const absolute = path.join(workspaceRoot, 'artifacts', key);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, body);
      return { key, url: pathToFileURL(absolute).href };
    },
  };
}
