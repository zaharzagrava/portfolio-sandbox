import { describe, expect, it } from 'vitest';
import {
  buildQuery,
  readCursor,
  readDays,
  readInventoryParams,
  readLogsParams,
  readOrdersParams,
  readTeamParams,
  readUsageParams,
  readWebhookAttemptsParams,
} from './search-params';

const UUID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

describe('W04 AS-12 readDays', () => {
  it.each([
    ['7', 7],
    ['30', 30],
    ['90', 90],
    [undefined, 30],
    ['', 30],
    ['0', 30],
    ['365', 30],
    ['abc', 30],
    ['7.5', 30],
    [['7', '90'], 30],
  ] as const)('%j gives %i', (raw, expected) => {
    expect(readDays(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe('W04 AS-29 readInventoryParams', () => {
  it('defaults: active products, any stock, no search, no cursor', () => {
    expect(readInventoryParams({})).toEqual({ q: '', status: 'ACTIVE', inStock: undefined, cursor: undefined });
  });

  it('reads the filters', () => {
    expect(readInventoryParams({ q: 'ceramc mug', status: 'ARCHIVED', inStock: 'false', cursor: 'abc' })).toEqual({
      q: 'ceramc mug',
      status: 'ARCHIVED',
      inStock: false,
      cursor: 'abc',
    });
    expect(readInventoryParams({ inStock: 'true' }).inStock).toBe(true);
  });

  it.each([
    [{ status: 'DRAFT' }, { status: 'ACTIVE' }],
    [{ status: ['ACTIVE', 'ARCHIVED'] }, { status: 'ACTIVE' }],
    [{ inStock: 'maybe' }, { inStock: undefined }],
    [{ q: ['a', 'b'] }, { q: '' }],
    [{ q: 'x'.repeat(300) }, { q: 'x'.repeat(200) }],
    [{ cursor: '' }, { cursor: undefined }],
    [{ cursor: 'c'.repeat(600) }, { cursor: undefined }],
  ])('replaces the invalid value in %j by its default', (raw, expected) => {
    expect(readInventoryParams(raw as Record<string, string | string[] | undefined>)).toMatchObject(expected);
  });
});

describe('W04 readCursor and the list readers', () => {
  it('readCursor accepts a short opaque string only', () => {
    expect(readCursor('abc_-=')).toBe('abc_-=');
    expect(readCursor(undefined)).toBeUndefined();
    expect(readCursor(['a', 'b'])).toBeUndefined();
    expect(readCursor('has space')).toBeUndefined();
  });

  it('orders: status and cursor', () => {
    expect(readOrdersParams({ status: 'PAID', cursor: 'x' })).toEqual({ status: 'PAID', cursor: 'x' });
    expect(readOrdersParams({ status: 'paid; drop' })).toEqual({ status: undefined, cursor: undefined });
  });

  it('team: tab (members default), invitation status (pending default), cursor', () => {
    expect(readTeamParams({})).toEqual({ tab: 'members', status: 'pending', cursor: undefined });
    expect(readTeamParams({ tab: 'roles', status: 'expired', cursor: 'c' })).toEqual({ tab: 'roles', status: 'expired', cursor: 'c' });
    expect(readTeamParams({ tab: 'billing', status: 'nope' })).toMatchObject({ tab: 'members', status: 'pending' });
  });

  it('usage: 7, 14 or 30 days (30 default) and the mode (live default)', () => {
    expect(readUsageParams({})).toEqual({ days: 30, livemode: true });
    expect(readUsageParams({ days: '14', livemode: 'false' })).toEqual({ days: 14, livemode: false });
    expect(readUsageParams({ days: '90', livemode: 'x' })).toEqual({ days: 30, livemode: true });
  });

  it('webhook attempts: ok=false filter, event, cursor', () => {
    expect(readWebhookAttemptsParams({ ok: 'false', event: UUID, cursor: 'c' })).toEqual({ ok: false, event: UUID, cursor: 'c' });
    expect(readWebhookAttemptsParams({ ok: 'true' }).ok).toBe(true);
    expect(readWebhookAttemptsParams({ ok: '1', event: 'not-a-uuid' })).toEqual({ ok: undefined, event: undefined, cursor: undefined });
  });

  it('logs: every filter, defaults omitted, a bad value becomes the default', () => {
    expect(readLogsParams({})).toEqual({
      requestId: '',
      status: 'any',
      route: '',
      keyId: undefined,
      livemode: undefined,
      from: undefined,
      to: undefined,
      cursor: undefined,
    });
    expect(readLogsParams({ requestId: 'req_1', status: '4xx', route: '/v1/products', keyId: UUID, livemode: 'true', from: '2026-10-01', to: '2026-10-05', cursor: 'c' })).toEqual({
      requestId: 'req_1',
      status: '4xx',
      route: '/v1/products',
      keyId: UUID,
      livemode: true,
      from: '2026-10-01',
      to: '2026-10-05',
      cursor: 'c',
    });
    expect(readLogsParams({ status: '3xx', keyId: 'x', livemode: 'maybe', from: '10/01/2026', to: '2026-13-45' })).toMatchObject({
      status: 'any',
      keyId: undefined,
      livemode: undefined,
      from: undefined,
      to: undefined,
    });
  });
});

describe('W04 FR-004 buildQuery', () => {
  it('omits defaults and empty values, keeps the rest in a stable order', () => {
    expect(buildQuery({ days: 30, q: '', status: 'ACTIVE', cursor: undefined }, { days: 30, status: 'ACTIVE' })).toBe('');
    expect(buildQuery({ days: 90 }, { days: 30 })).toBe('days=90');
    expect(buildQuery({ status: 'ARCHIVED', q: 'a b', inStock: false }, { status: 'ACTIVE' })).toBe('status=ARCHIVED&q=a+b&inStock=false');
  });
});
