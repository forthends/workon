import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface WorkonConfig {
  port: number;
  clients: { qoder: string; cursor: string };
}

export function loadConfig(workspaceRoot: string): WorkonConfig {
  const raw = readFileSync(path.join(workspaceRoot, 'config.json'), 'utf8');
  return JSON.parse(raw) as WorkonConfig;
}
