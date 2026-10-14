import { describe, expect, it } from 'vitest';
import { noStorePaths } from '@/lib/security/headers';

// `lib/config.ts` is server-only and reads the process environment; the robots route takes the site address from it.
import robots from './robots';

describe('W07 robots (AS-34, FR-052)', () => {
  it('W07 AS-34: public pages are allowed and the disallow list is exactly the no-store paths', () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule.userAgent).toBe('*');
    expect(rule.allow).toBe('/');
    expect(rule.disallow).toEqual(noStorePaths);
  });

  it('W07 AS-34: the disallow list names every private area of the spec', () => {
    const disallow = robots().rules;
    const list = (Array.isArray(disallow) ? disallow[0].disallow : disallow.disallow) as string[];
    for (const path of ['/api/', '/dashboard/', '/account/', '/admin/', '/checkout/', '/cart', '/chat', '/invites/']) expect(list).toContain(path);
  });

  it('W07 AS-34: no host or sitemap is invented when it is not configured; the host is the configured public address', () => {
    const result = robots();
    expect(result.sitemap).toBeUndefined();
    expect(result.host).toMatch(/^https?:\/\//);
  });
});
