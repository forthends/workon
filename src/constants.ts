import type { ClientId } from './types.js';

export const RUN_TIMEOUT_MS = 15 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 5_000;
export const KILL_GRACE_MS = 5_000;
export const STDOUT_LIMIT = 1_048_576;
export const CLIENT_PRIORITY: readonly ClientId[] = ['qoder', 'cursor'];
