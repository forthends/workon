import type { RequirementStatus } from './types.js';

export class WorkonError extends Error {
  constructor(
    readonly statusCode: number,
    readonly error: 'invalid' | 'conflict' | 'not_found',
    message: string,
    readonly requirementStatus?: RequirementStatus,
  ) {
    super(message);
  }
}
