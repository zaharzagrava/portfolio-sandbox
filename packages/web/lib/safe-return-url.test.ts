import { describe, expect, it } from 'vitest';
import { safeReturnUrl } from './safe-return-url';

describe('safeReturnUrl', () => {
  it('keeps same-site paths', () => {
    expect(safeReturnUrl('/checkout')).toBe('/checkout');
    expect(safeReturnUrl('/chat?product=1')).toBe('/chat?product=1');
  });

  it('rejects anything that could leave the site', () => {
    for (const url of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, undefined]) {
      expect(safeReturnUrl(url)).toBe('/');
    }
  });
});
