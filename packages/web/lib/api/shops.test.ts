import { describe, expect, it } from 'vitest';
import { SHOP_SLUG, slugify } from './shops';

describe('slugify', () => {
  it('produces slugs the server accepts', () => {
    for (const name of ['Demo Shop', '  Café & Co. ', 'ACME---Tools!!', 'x'.repeat(60) + ' shop']) {
      const slug = slugify(name);
      expect(slug === '' || SHOP_SLUG.test(slug) || slug.length < 3).toBe(true);
    }
    expect(slugify('Demo Shop')).toBe('demo-shop');
    expect(slugify('ACME---Tools!!')).toBe('acme-tools');
  });

  it('never ends with a dash after truncation', () => {
    expect(slugify('a'.repeat(39) + ' b')).not.toMatch(/-$/);
  });
});
