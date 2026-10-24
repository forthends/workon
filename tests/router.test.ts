import { describe, expect, it } from 'vitest';
import { routeRequirement } from '../src/router.js';

describe('router', () => {
  it('assigns every requirement to the PRD skill', () => {
    expect(routeRequirement('req_000000000001')).toEqual({
      requirementId: 'req_000000000001',
      route: 'prd',
      role: 'product',
      skillId: 'workon-prd',
      size: 'unclassified',
    });
  });
});
