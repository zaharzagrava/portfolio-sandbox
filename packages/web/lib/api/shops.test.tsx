import { describe, expect, it } from 'vitest';
import { SHOP_SLUG, slugify } from './shops';

describe('W04 AS-01: the shop handle offered while opening a shop', () => {
  it('W04 AS-01: a handle derived from the shop name matches the pattern the server accepts', () => {
    const handle = slugify('E2E Shop 42');
    expect(handle).toBe('e2e-shop-42');
    expect(SHOP_SLUG.test(handle)).toBe(true);
  });

  it('W04 AS-01: a handle with a leading or trailing dash is not accepted', () => {
    expect(SHOP_SLUG.test('-shop')).toBe(false);
    expect(SHOP_SLUG.test('shop-')).toBe(false);
  });

  it('W04 AS-01: a handle is lowercase, has no spaces and fits the 40 characters the server accepts', () => {
    const handle = slugify(`Ünïcode  Shop ${'x'.repeat(80)}`);
    expect(handle).toMatch(/^[a-z0-9-]+$/);
    expect(handle.length).toBeLessThanOrEqual(40);
    expect(SHOP_SLUG.test(handle)).toBe(true);
  });
});
