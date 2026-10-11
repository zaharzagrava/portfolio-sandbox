import { afterEach, describe, expect, it, vi } from 'vitest';
import { csrfHeaders, hasCsrfCookie } from './csrf';

/** jsdom refuses to set `__Host-` cookies over http, so the cookie jar is stubbed. */
const stubCookies = (value: string) => vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);

describe('csrfHeaders', () => {
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-28: reads the __Host-bff-csrf cookie and decodes it', () => {
    stubCookies('other=1; __Host-bff-csrf=abc%2Bdef.ghi; theme=dark');
    expect(csrfHeaders()).toEqual({ 'X-CSRF-Token': 'abc+def.ghi' });
    expect(hasCsrfCookie()).toBe(true);
  });

  it('W01 AS-28: does not match a cookie that only ends with the same name, nor the old name', () => {
    stubCookies('x__Host-bff-csrf=evil; __Host-csrf=old');
    expect(csrfHeaders()).toEqual({});
    expect(hasCsrfCookie()).toBe(false);
  });

  it('W01 AS-28: returns nothing when the cookie is absent', () => {
    stubCookies('');
    expect(csrfHeaders()).toEqual({});
  });
});
