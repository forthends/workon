import { execFileSync } from 'node:child_process';

export function createMacNotifier(): { notify(summary: string): void } {
  return {
    notify(summary: string) {
      const escaped = summary.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      execFileSync('osascript', ['-e', `display notification "${escaped}" with title "workon"`], { stdio: 'ignore' });
    },
  };
}
