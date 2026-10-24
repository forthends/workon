import { randomBytes } from 'node:crypto';

export type IdPrefix = 'req' | 'note' | 'art' | 'evt' | 'inb';
export interface Ids {
  next(prefix: IdPrefix): string;
}

export function createIds(): Ids {
  return {
    next(prefix) {
      return `${prefix}_${randomBytes(6).toString('hex')}`;
    },
  };
}

export function sequentialIds(): Ids {
  const counters: Record<string, number> = {};
  return {
    next(prefix) {
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      return `${prefix}_${counters[prefix].toString(16).padStart(12, '0')}`;
    },
  };
}
