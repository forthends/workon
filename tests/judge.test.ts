import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { judgeAttempt } from '../src/judge.js';
import { tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function taskDir(): string {
  const { dir, cleanup } = tempDir('workon-judge-');
  cleanups.push(cleanup);
  return dir;
}

describe('judgeAttempt', () => {
  it('returns timeout when timedOut is true even with a valid report', () => {
    const dir = taskDir();
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ outcome: 'completed', reason: '' }));
    mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    writeFileSync(path.join(dir, 'artifacts', 'prd.md'), '# PRD');
    expect(judgeAttempt(dir, { exitCode: 0, timedOut: true })).toEqual({
      status: 'timeout',
      error: '执行超时',
    });
  });

  it('returns completed when report is completed and PRD exists regardless of exit code', () => {
    const dir = taskDir();
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ outcome: 'completed', reason: '' }));
    mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    const prdPath = path.join(dir, 'artifacts', 'prd.md');
    writeFileSync(prdPath, '# PRD');
    expect(judgeAttempt(dir, { exitCode: 1, timedOut: false })).toEqual({
      status: 'completed',
      prdPath,
    });
  });

  it('returns failed when completed but PRD file is missing', () => {
    const dir = taskDir();
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ outcome: 'completed', reason: '' }));
    expect(judgeAttempt(dir, { exitCode: 0, timedOut: false })).toEqual({
      status: 'failed',
      error: '没有 PRD 文件',
    });
  });

  it('returns failed with exit code when report.json is missing', () => {
    const dir = taskDir();
    const result = judgeAttempt(dir, { exitCode: 2, timedOut: false });
    expect(result).toEqual({ status: 'failed', error: '退出码 2' });
  });

  it('returns failed when report.json is not valid JSON', () => {
    const dir = taskDir();
    writeFileSync(path.join(dir, 'report.json'), 'not-json');
    expect(judgeAttempt(dir, { exitCode: 0, timedOut: false })).toEqual({
      status: 'failed',
      error: 'report.json 无法解析',
    });
  });

  it('returns blocked with default reason when reason is blank', () => {
    const dir = taskDir();
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ outcome: 'blocked', reason: '  ' }));
    expect(judgeAttempt(dir, { exitCode: 0, timedOut: false })).toEqual({
      status: 'blocked',
      reason: '需要补充信息',
    });
  });

  it('returns failed when outcome is invalid', () => {
    const dir = taskDir();
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ outcome: 'other' }));
    expect(judgeAttempt(dir, { exitCode: 0, timedOut: false })).toEqual({
      status: 'failed',
      error: 'outcome 无效',
    });
  });
});
