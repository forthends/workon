export function createWake(): { wake(): void; wait(signal: AbortSignal): Promise<void> } {
  let flag = false;
  let resolveWait: (() => void) | null = null;

  const finishWait = () => {
    flag = false;
    resolveWait?.();
    resolveWait = null;
  };

  return {
    wake() {
      flag = true;
      if (resolveWait) {
        finishWait();
      }
    },
    wait(signal: AbortSignal): Promise<void> {
      if (flag) {
        flag = false;
        return Promise.resolve();
      }
      if (signal.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          resolveWait = null;
          resolve();
        };
        resolveWait = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        signal.addEventListener('abort', onAbort);
      });
    },
  };
}
