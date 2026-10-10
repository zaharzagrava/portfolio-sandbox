import * as fc from 'fast-check';
import { BloomFilter, WindowCaps } from './visitor-cap';
import { seededRandom } from './testing/seeded-random';

const BITS = 1 << 16;
let seq = 0;
const eventId = () => `event-${seq++}`;

describe('S35 per-visitor cap and duplicate filter (U7)', () => {
  it('S35 AS-22: one visitor, one vote per event name and product within a window', () => {
    const caps = new WindowCaps(BITS);
    expect(caps.admit(eventId(), 'visitor-1', 'product_view', 'A')).toBe(
      'fresh',
    );
    for (let i = 0; i < 49; i++)
      expect(caps.admit(eventId(), 'visitor-1', 'product_view', 'A')).toBe(
        'visitor_capped',
      );
  });

  it('S35 AS-22: another event name, another product and another visitor each count', () => {
    const caps = new WindowCaps(BITS);
    expect(caps.admit(eventId(), 'visitor-1', 'product_view', 'A')).toBe(
      'fresh',
    );
    expect(caps.admit(eventId(), 'visitor-1', 'add_to_cart', 'A')).toBe(
      'fresh',
    );
    expect(caps.admit(eventId(), 'visitor-1', 'product_view', 'B')).toBe(
      'fresh',
    );
    expect(caps.admit(eventId(), 'visitor-2', 'product_view', 'A')).toBe(
      'fresh',
    );
    expect(caps.admit(eventId(), 'visitor-2', 'add_to_cart', 'A')).toBe(
      'fresh',
    );
  });

  it('S35 AS-22: a new window starts with new filters, so the same visitor counts again', () => {
    const first = new WindowCaps(BITS);
    const next = new WindowCaps(BITS);
    expect(first.admit(eventId(), 'visitor-1', 'product_view', 'A')).toBe(
      'fresh',
    );
    expect(first.admit(eventId(), 'visitor-1', 'product_view', 'A')).toBe(
      'visitor_capped',
    );
    expect(next.admit(eventId(), 'visitor-1', 'product_view', 'A')).toBe(
      'fresh',
    );
  });

  it('S35 AS-29: the same event_id twice is a duplicate, whatever else it says', () => {
    const caps = new WindowCaps(BITS);
    expect(caps.admit('e-1', 'visitor-1', 'product_view', 'A')).toBe('fresh');
    expect(caps.admit('e-1', 'visitor-1', 'product_view', 'A')).toBe(
      'duplicate',
    );
    expect(caps.admit('e-1', 'visitor-9', 'add_to_cart', 'Z')).toBe(
      'duplicate',
    );
  });

  it('S35 AS-22: property - no false "unseen" (everything added is reported seen)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { maxLength: 300 }),
        (keys) => {
          const filter = new BloomFilter(1 << 14);
          for (const key of keys) filter.add(key);
          return keys.every((key) => filter.has(key));
        },
      ),
      { seed: 3, numRuns: 100 },
    );
  });

  it('S35 AS-22: false "seen" stays at or below 1% on a seeded stream at the design load', () => {
    const random = seededRandom(99);
    const bits = 1 << 20;
    const filter = new BloomFilter(bits);
    const entries = Math.floor(bits / 10); // ~10 bits per entry
    for (let i = 0; i < entries; i++) filter.add(`in-${i}-${random()}`);
    let falsePositives = 0;
    const probes = 50_000;
    for (let i = 0; i < probes; i++)
      if (filter.has(`out-${i}-${random()}`)) falsePositives++;
    expect(falsePositives / probes).toBeLessThanOrEqual(0.01);
  });

  it('S35 AS-22: memory is two bit arrays of the configured size', () => {
    expect(new WindowCaps(1 << 20).byteSize).toBe(2 * ((1 << 20) / 8));
  });
});
