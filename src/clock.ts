export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function manualClock(startIso = '2026-10-24T00:00:00.000Z'): Clock & { advance(ms: number): void } {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advance(msDelta: number) {
      ms += msDelta;
    },
  };
}
