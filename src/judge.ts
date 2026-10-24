import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface JudgeInput { exitCode: number | null; timedOut: boolean }
export type JudgeResult =
  | { status: 'completed'; prdPath: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; error: string }
  | { status: 'timeout'; error: string };

export function judgeAttempt(taskDir: string, exit: JudgeInput): JudgeResult {
  if (exit.timedOut) return { status: 'timeout', error: '执行超时' };
  const reportPath = path.join(taskDir, 'report.json');
  const prdPath = path.join(taskDir, 'artifacts', 'prd.md');
  if (!existsSync(reportPath)) {
    return { status: 'failed', error: exit.exitCode === null ? '没有 report.json' : `退出码 ${exit.exitCode}` };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return { status: 'failed', error: 'report.json 无法解析' }; }
  if (!parsed || typeof parsed !== 'object') return { status: 'failed', error: 'report.json 无法解析' };
  const outcome = (parsed as { outcome?: unknown }).outcome;
  const reason = (parsed as { reason?: unknown }).reason;
  if (outcome === 'completed') {
    if (!existsSync(prdPath)) return { status: 'failed', error: '没有 PRD 文件' };
    return { status: 'completed', prdPath };
  }
  if (outcome === 'blocked') {
    const text = typeof reason === 'string' ? reason.trim() : '';
    return { status: 'blocked', reason: text || '需要补充信息' };
  }
  return { status: 'failed', error: 'outcome 无效' };
}
