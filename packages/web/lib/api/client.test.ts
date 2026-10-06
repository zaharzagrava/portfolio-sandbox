import { afterEach, describe, expect, it, vi } from 'vitest';
import { csrfHeaders } from './client';

/** jsdom refuses to set `__Host-` cookies over http, so the cookie jar is stubbed. */
const stubCookies = (value: string) => vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);

describe('csrfHeaders', () => {
  afterEach(() => vi.restoreAllMocks());

  it('echoes the readable __Host-csrf cookie (double submit)', () => {
    stubCookies('other=1; __Host-csrf=abc%2Bdef; theme=dark');
    expect(csrfHeaders()).toEqual({ 'x-csrf-token': 'abc+def' });
  });

  it('does not match a cookie that only ends with the same name', () => {
    stubCookies('x__Host-csrf=evil');
    expect(csrfHeaders()).toEqual({});
  });

  it('sends nothing when there is no session cookie', () => {
    stubCookies('');
    expect(csrfHeaders()).toEqual({});
  });
});
