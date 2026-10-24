import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Note } from './types.js';

export function writeTaskMarkdown(taskDir: string, input: { text: string; notes: Note[] }): void {
  const { text, notes } = input;
  const sorted = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const feedback =
    sorted.length === 0
      ? '无'
      : sorted
          .map((note) => `- ${note.kind === 'reject' ? '退回' : '补充'}：${note.body}`)
          .join('\n');

  const content = `# 需求

${text}

# 已有反馈

${feedback}
`;

  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, 'TASK.md'), content, 'utf8');
}
