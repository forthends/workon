import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createIds } from './ids.js';
import { SKILL_TEMPLATE } from './skills.js';
import { openStore } from './store.js';

const DEFAULT_CONFIG = {
  port: 4787,
  clients: {
    qoder: 'qoder',
    cursor: 'agent',
  },
};

export function initWorkspace(cwd: string): void {
  const workspaceRoot = path.join(cwd, '.workon');
  if (existsSync(workspaceRoot)) {
    throw new Error('工作区已存在');
  }

  mkdirSync(path.join(workspaceRoot, 'knowledge'), { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'config.json'), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
  const skillDir = path.join(workspaceRoot, 'skills', 'workon-prd');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_TEMPLATE, 'utf8');
  openStore(path.join(workspaceRoot, 'workon.sqlite'), createIds()).close();
}
