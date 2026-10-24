import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function copyKnowledge(fromDir: string, toDir: string): void {
  if (!existsSync(fromDir)) return;

  function walk(current: string): void {
    for (const name of readdirSync(current)) {
      const source = path.join(current, name);
      if (statSync(source).isDirectory()) {
        walk(source);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      const relative = path.relative(fromDir, source);
      const dest = path.join(toDir, relative);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    }
  }

  walk(fromDir);
}
