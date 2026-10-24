import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTaskMarkdown } from '../src/context.js';
import { copyKnowledge } from '../src/knowledge.js';
import type { Note } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'workon-context-'));
  dirs.push(dir);
  return dir;
}

function listMdFiles(root: string): string[] {
  const result: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) result.push(path.relative(root, full));
    }
  }
  if (existsSync(root)) walk(root);
  return result.sort();
}

function feedbackSection(taskMd: string): string {
  const match = taskMd.match(/# 已有反馈\n\n([\s\S]*?)(?:\n\n# |$)/);
  return match ? match[1].trim() : '';
}

describe('copyKnowledge', () => {
  it('copies only markdown files preserving nested paths', () => {
    const root = newTmp();
    const fromDir = path.join(root, 'knowledge');
    mkdirSync(path.join(fromDir, 'nested'), { recursive: true });
    writeFileSync(path.join(fromDir, 'a.md'), 'a');
    writeFileSync(path.join(fromDir, 'nested', 'b.md'), 'b');
    writeFileSync(path.join(fromDir, 'skip.txt'), 'skip');

    const toDir = path.join(root, 'dest', 'knowledge');
    copyKnowledge(fromDir, toDir);

    expect(listMdFiles(toDir)).toEqual(['a.md', 'nested/b.md']);
    expect(existsSync(path.join(toDir, 'skip.txt'))).toBe(false);
  });

  it('returns when source directory does not exist', () => {
    const root = newTmp();
    const toDir = path.join(root, 'dest');
    expect(() => copyKnowledge(path.join(root, 'missing'), toDir)).not.toThrow();
    expect(existsSync(toDir)).toBe(false);
  });
});

describe('writeTaskMarkdown', () => {
  it('writes 无 when there are no notes', () => {
    const taskDir = newTmp();
    writeTaskMarkdown(taskDir, { text: '需求正文', notes: [] });
    const content = readFileSync(path.join(taskDir, 'TASK.md'), 'utf8');
    expect(feedbackSection(content)).toBe('无');
    expect(content).toContain('# 需求\n\n需求正文');
  });

  it('lists reject and supplement notes in chronological order', () => {
    const taskDir = newTmp();
    const notes: Note[] = [
      {
        id: 'n2',
        requirementId: 'r1',
        kind: 'supplement',
        body: '说明',
        createdAt: '2026-10-24T00:00:02.000Z',
      },
      {
        id: 'n1',
        requirementId: 'r1',
        kind: 'reject',
        body: '意见',
        createdAt: '2026-10-24T00:00:01.000Z',
      },
    ];
    writeTaskMarkdown(taskDir, { text: '需求', notes });
    const content = readFileSync(path.join(taskDir, 'TASK.md'), 'utf8');
    expect(feedbackSection(content)).toBe('- 退回：意见\n- 补充：说明');
  });
});
