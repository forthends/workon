import type { Assignment } from './types.js';

export function routeRequirement(requirementId: string): Assignment {
  return {
    requirementId,
    route: 'prd',
    role: 'product',
    skillId: 'workon-prd',
    size: 'unclassified',
  };
}
