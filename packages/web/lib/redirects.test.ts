import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('Redirects of next.config', () => {
  it('W03 AS-60: /dashboard/orders permanently redirects to /orders', async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    const rule = rules.find((entry) => entry.source === '/dashboard/orders');
    expect(rule).toBeDefined();
    expect(rule?.destination).toBe('/orders');
    expect(rule?.permanent).toBe(true);
  });

  it('W03 AS-60: the old rule does not catch the new orders pages', async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    expect(rules.some((entry) => entry.source === '/orders' || entry.source.startsWith('/orders/'))).toBe(false);
  });
});
