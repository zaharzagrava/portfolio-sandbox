import {
  competitorPricesQuerySchema,
  competitorPricesSchema,
  competitorWatchListQuerySchema,
  competitorWatchSchema,
  createCompetitorWatchSchema,
} from './competitors.ts';
import {
  competitorPriceDroppedSchema,
  competitorShopStatusChangedSchema,
} from './competitor-events.ts';

const productId = '0197c1a0-0000-7000-8000-000000000001';
const instant = '2026-10-06T12:00:00.000Z';

describe('S41 competitor contracts (parse tests)', () => {
  it.each([
    ['valid', { productId, url: 'https://rival.test/p/1' }, true],
    ['unknown field', { productId, url: 'https://rival.test/', extra: 1 }, false],
    ['missing url', { productId }, false],
    ['url over 2048 characters', { productId, url: `https://a.test/${'a'.repeat(2048)}` }, false],
    ['url of exactly 2048 characters', { productId, url: `https://a.test/${'a'.repeat(2048 - 15)}` }, true],
    ['empty url', { productId, url: '' }, false],
    ['non uuid product', { productId: 'x', url: 'https://a.test/' }, false],
  ])('S41 AS-04: create body, %s', (_name, body, ok) => {
    expect(createCompetitorWatchSchema.safeParse(body).success).toBe(ok);
  });

  it.each([
    ['empty query defaults the limit to 50', {}, true, 50],
    ['limit 1', { limit: '1' }, true, 1],
    ['limit 100', { limit: '100' }, true, 100],
    ['limit 0', { limit: '0' }, false, 0],
    ['limit 101', { limit: '101' }, false, 0],
    ['unknown parameter', { foo: '1' }, false, 0],
    ['bad product id', { productId: 'nope' }, false, 0],
  ])('S41 AS-12: list query, %s', (_name, query, ok, limit) => {
    const parsed = competitorWatchListQuerySchema.safeParse(query);
    expect(parsed.success).toBe(ok);
    if (parsed.success) expect(parsed.data.limit).toBe(limit);
  });

  it.each([
    ['default 30', {}, true, 30],
    ['1', { days: '1' }, true, 1],
    ['365', { days: '365' }, true, 365],
    ['0', { days: '0' }, false, 0],
    ['366', { days: '366' }, false, 0],
    ['abc', { days: 'abc' }, false, 0],
  ])('S41 AS-14: prices query, %s', (_name, query, ok, days) => {
    const parsed = competitorPricesQuerySchema.safeParse(query);
    expect(parsed.success).toBe(ok);
    if (parsed.success) expect(parsed.data.days).toBe(days);
  });

  it('S41 AS-01: the watch response has no target id and rejects extra fields', () => {
    const watch = {
      id: productId,
      productId,
      url: 'https://rival.test/p/1',
      host: 'rival.test',
      status: 'ACTIVE',
      lastPriceMinor: null,
      currency: null,
      lastCheckedAt: null,
      lastStatus: null,
      nextCheckAt: instant,
      createdAt: instant,
    };
    expect(competitorWatchSchema.safeParse(watch).success).toBe(true);
    expect(
      competitorWatchSchema.safeParse({ ...watch, targetId: productId })
        .success,
    ).toBe(false);
  });

  it('S41 AS-14: an empty history parses', () => {
    expect(
      competitorPricesSchema.safeParse({
        watchId: productId,
        currency: null,
        from: instant,
        to: instant,
        points: [],
        lowestMinor: null,
        lowestAt: null,
        latestMinor: null,
      }).success,
    ).toBe(true);
  });

  it('S41 AS-43: the alert payload carries money as integers and nothing else', () => {
    const payload = {
      watchId: productId,
      shopId: productId,
      productId,
      productTitle: 'iPhone 17',
      host: 'rival.test',
      competitorPriceMinor: 89900,
      yourPriceMinor: 99900,
      currency: 'EUR',
      ownerId: 'u1',
      priceVersion: 1,
    };
    expect(competitorPriceDroppedSchema.safeParse(payload).success).toBe(true);
    expect(
      competitorPriceDroppedSchema.safeParse({ ...payload, url: 'x' }).success,
    ).toBe(false);
    expect(
      competitorPriceDroppedSchema.safeParse({
        ...payload,
        competitorPriceMinor: 899.5,
      }).success,
    ).toBe(false);
  });

  it('S41 AS-53: a shop status event with an unknown status is rejected', () => {
    expect(
      competitorShopStatusChangedSchema.safeParse({
        shopId: productId,
        to: 'BANNED',
        shopVersion: 1,
      }).success,
    ).toBe(false);
  });
});
