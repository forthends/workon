export function buildPrompt(skillPath: string): string {
  return [
    '执行技能 /workon-prd。',
    `若同名技能有多份，只遵循这个文件：${skillPath}`,
    '阅读 TASK.md 和 knowledge/ 目录中的 Markdown。',
    '按技能要求把结果写在当前目录。',
  ].join('\n');
}
