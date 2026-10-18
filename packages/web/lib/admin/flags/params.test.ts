import { describe, expect, it } from 'vitest';
import { isFlagKey, listHref, parseHistoryParams, parseListParams, parseStaleParams, staleHref } from './params';

describe('flag console URL parameters', () => {
  it('W06 AS-02: status is one of the closed set, anything else is "all"', () => {
    expect(parseListParams({ status: 'killed' })).toEqual({ status: 'killed', cursor: undefined });
    expect(parseListParams({ status: 'bogus' }).status).toBe('all');
    expect(parseListParams({}).status).toBe('all');
    expect(parseListParams({ status: ['killed', 'enabled'] }).status).toBe('all');
    for (const status of ['all', 'enabled', 'disabled', 'killed', 'archived']) expect(parseListParams({ status }).status).toBe(status);
  });

  it('W06 AS-04: the cursor is kept as an opaque string, an empty or repeated one is dropped', () => {
    expect(parseListParams({ cursor: 'abc' }).cursor).toBe('abc');
    expect(parseListParams({ cursor: '' }).cursor).toBeUndefined();
    expect(parseListParams({ cursor: ['a', 'b'] }).cursor).toBeUndefined();
  });

  it('W06 AS-46: days is 1..30 and defaults to 14', () => {
    expect(parseStaleParams({ days: '7' }).days).toBe(7);
    expect(parseStaleParams({ days: '30' }).days).toBe(30);
    expect(parseStaleParams({ days: '1' }).days).toBe(1);
    for (const days of ['0', '31', '-3', 'x', '7.5', '', ['7', '8']]) expect(parseStaleParams({ days }).days).toBe(14);
    expect(parseStaleParams({}).days).toBe(14);
  });

  it('W06 AS-42: the history cursor is read from the URL', () => {
    expect(parseHistoryParams({ cursor: 'c1' })).toEqual({ cursor: 'c1' });
    expect(parseHistoryParams({})).toEqual({ cursor: undefined });
  });

  it('W06 AS-02: links are built by the same module; changing the status drops the cursor; the default status is not written', () => {
    expect(listHref({ status: 'all' })).toBe('/admin/feature-flags');
    expect(listHref({ status: 'killed' })).toBe('/admin/feature-flags?status=killed');
    expect(listHref({ status: 'killed', cursor: 'c1' })).toBe('/admin/feature-flags?status=killed&cursor=c1');
    expect(listHref({ status: 'all', cursor: 'c 1' })).toBe('/admin/feature-flags?cursor=c%201');
  });

  it('W06 AS-03: the archived list asks for includeArchived', () => {
    expect(parseListParams({ status: 'archived' }).status).toBe('archived');
    expect(listHref({ status: 'archived' })).toBe('/admin/feature-flags?status=archived');
  });

  it('W06 AS-46: stale links carry tab=stale and the window only when it is not the default', () => {
    expect(staleHref(14)).toBe('/admin/feature-flags?tab=stale');
    expect(staleHref(7)).toBe('/admin/feature-flags?tab=stale&days=7');
  });

  it('W06 AS-54: a key must match the contracts pattern', () => {
    expect(isFlagKey('new-checkout')).toBe(true);
    expect(isFlagKey('a')).toBe(false);
    expect(isFlagKey('Bad_Key!')).toBe(false);
    expect(isFlagKey('x'.repeat(65))).toBe(false);
  });
});
