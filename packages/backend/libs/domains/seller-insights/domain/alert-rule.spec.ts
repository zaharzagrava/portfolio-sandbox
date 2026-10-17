import { z } from 'zod';
import {
  AlertInput,
  AlertOutcome,
  eventIdFor,
  shouldAlert,
} from './alert-rule';

const base: AlertInput = {
  competitorPriceMinor: 8000,
  competitorCurrency: 'EUR',
  yourPriceMinor: 9000,
  yourCurrency: 'EUR',
  productActive: true,
  shopActive: true,
  lastEvaluatedPriceMinor: null,
};

describe('S41 AS-43: alert condition (FR-025)', () => {
  it.each<[string, Partial<AlertInput>, AlertOutcome]>([
    ['undercut, first evaluation', {}, 'alert'],
    ['undercut, previously higher', { lastEvaluatedPriceMinor: 8500 }, 'alert'],
    [
      'undercut, previous was above yours',
      { lastEvaluatedPriceMinor: 9500 },
      'alert',
    ],
    ['one minor unit below', { competitorPriceMinor: 8999 }, 'alert'],
    ['equal price', { competitorPriceMinor: 9000 }, 'not_undercut'],
    ['higher price', { competitorPriceMinor: 9500 }, 'not_undercut'],
    [
      'higher price with previous evaluation',
      { competitorPriceMinor: 9500, lastEvaluatedPriceMinor: 10000 },
      'not_undercut',
    ],
    [
      'other currency, lower number',
      { competitorCurrency: 'USD' },
      'currency_mismatch',
    ],
    [
      'other currency, higher number',
      { competitorCurrency: 'USD', competitorPriceMinor: 99999 },
      'currency_mismatch',
    ],
    ['product inactive', { productActive: false }, 'product_unavailable'],
    ['shop inactive', { shopActive: false }, 'shop_inactive'],
    [
      'product and shop inactive reports the product',
      { productActive: false, shopActive: false },
      'product_unavailable',
    ],
    [
      'same price as previous evaluation',
      { lastEvaluatedPriceMinor: 8000 },
      'not_lower_than_previous',
    ],
    [
      'higher than previous evaluation',
      { lastEvaluatedPriceMinor: 7000 },
      'not_lower_than_previous',
    ],
    [
      'flap back below after rising: lower than the last evaluated',
      { competitorPriceMinor: 7500, lastEvaluatedPriceMinor: 8800 },
      'alert',
    ],
  ])('S41 AS-43: %s -> %s', (_name, patch, outcome) => {
    expect(shouldAlert({ ...base, ...patch })).toEqual({
      alert: outcome === 'alert',
      outcome,
    });
  });
});

describe('S41 AS-43: deterministic event id', () => {
  it('S41 AS-43: same inputs give the same id', () => {
    expect(eventIdFor('w1', 3, 'o1')).toBe(eventIdFor('w1', 3, 'o1'));
  });

  it.each([
    ['watch', eventIdFor('w2', 3, 'o1')],
    ['version', eventIdFor('w1', 4, 'o1')],
    ['owner', eventIdFor('w1', 3, 'o2')],
  ])('S41 AS-43: a different %s gives a different id', (_name, other) => {
    expect(other).not.toBe(eventIdFor('w1', 3, 'o1'));
  });

  it('S41 AS-43: fields are not ambiguous when concatenated', () => {
    expect(eventIdFor('a', 1, 'b')).not.toBe(eventIdFor('a1', 1, 'b'));
  });

  it('S41 AS-43: id is a valid UUIDv7 (version 7, variant 10)', () => {
    for (let i = 0; i < 200; i++) {
      const id = eventIdFor(`watch-${i}`, i, `owner-${i % 7}`);
      expect(z.uuidv7().safeParse(id).success).toBe(true);
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]);
    }
  });
});
