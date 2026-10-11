import { describe, expect, it } from 'vitest';
import { sessionResponseSchema } from '@marketplace-sandbox/contracts';

describe('W01 tooling', () => {
  it('W01 T002: the contracts workspace resolves from a Vitest test', () => {
    expect(typeof sessionResponseSchema.safeParse).toBe('function');
  });
});
