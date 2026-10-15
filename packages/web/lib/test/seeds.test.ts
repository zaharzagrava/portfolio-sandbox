// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../tests/helpers', () => ({ API_URL: 'http://api.test', sellerCall: vi.fn(), sellerSession: vi.fn() }));

import { missingBuiltSeeds, NO_HOOK_SEEDS } from '../../tests/seeds';

describe('W02 B-6 journey seeds (tests/seeds.ts)', () => {
  it('names the built seed whose seller API is absent, with its owner and journeys', async () => {
    const missing = await missingBuiltSeeds(async (route) => (route.endsWith('/pickup-points') ? 404 : 200), 'shop-1');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('pickup point with stock');
    expect(missing[0]).toContain('S19');
    expect(missing[0]).toContain('tests/storefront-discovery.spec.ts');
  });

  it('reports nothing when both seller APIs answer, and names both when neither does', async () => {
    expect(await missingBuiltSeeds(async () => 200, 'shop-1')).toEqual([]);
    expect(await missingBuiltSeeds(async () => 404, 'shop-1')).toHaveLength(2);
  });

  it('lists the seeds without an owner hook, each with its owner', () => {
    expect(NO_HOOK_SEEDS.map((seed) => seed.owner).sort()).toEqual(['S30', 'S33', 'S34', 'S35', 'S47']);
  });
});
