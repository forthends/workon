import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSkill, mountSkill, SKILL_TEMPLATE } from '../src/skills.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'workon-skills-'));
  dirs.push(dir);
  return dir;
}

describe('skills', () => {
  it('loads workon-prd skill from workspace', () => {
    const workspace = newTmp();
    const skillPath = path.join(workspace, 'skills', 'workon-prd', 'SKILL.md');
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, SKILL_TEMPLATE, 'utf8');

    const loaded = loadSkill(workspace);
    expect(loaded.id).toBe('workon-prd');
    expect(loaded.absolutePath).toBe(skillPath);
    expect(loaded.body).toBe(SKILL_TEMPLATE);
  });

  it('throws when skill name does not match directory', () => {
    const workspace = newTmp();
    const skillPath = path.join(workspace, 'skills', 'workon-prd', 'SKILL.md');
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, '---\nname: other\n---\n', 'utf8');

    expect(() => loadSkill(workspace)).toThrow("技能名与目录不一致");
  });

  it('mounts skill for qoder under .qoder/skills/workon-prd/SKILL.md', () => {
    const taskDir = newTmp();
    const body = 'custom skill body';
    const mounted = mountSkill(taskDir, 'qoder', body);
    expect(mounted.endsWith('.qoder/skills/workon-prd/SKILL.md')).toBe(true);
    expect(readFileSync(mounted, 'utf8')).toBe(body);
  });

  it('mounts skill for cursor under .cursor/skills/workon-prd/SKILL.md', () => {
    const taskDir = newTmp();
    const body = 'cursor skill';
    const mounted = mountSkill(taskDir, 'cursor', body);
    expect(mounted.endsWith('.cursor/skills/workon-prd/SKILL.md')).toBe(true);
    expect(readFileSync(mounted, 'utf8')).toBe(body);
  });

  it('SKILL_TEMPLATE contains name: workon-prd', () => {
    expect(SKILL_TEMPLATE).toContain('name: workon-prd');
  });
});
