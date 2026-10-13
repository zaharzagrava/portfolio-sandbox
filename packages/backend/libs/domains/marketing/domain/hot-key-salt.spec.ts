import { createHash } from 'node:crypto';
import { HOT_KEY_SALTS, clickKey, hotKeySalt } from './hot-key-salt';

/** 10,000 fixed, distinct, uuid-shaped ids (a hash of the counter, so the set never changes between runs). */
const fixedIds = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const h = createHash('sha256').update(`click-${i}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  });

describe('S36 AS-37: hot-key salt (pure)', () => {
  const ids = fixedIds(10_000);

  it('is deterministic: a retried click goes to the same salt', () => {
    for (const id of ids.slice(0, 200))
      expect(hotKeySalt(id)).toBe(hotKeySalt(id));
  });

  it('is always an integer within 0-9', () => {
    expect(HOT_KEY_SALTS).toBe(10);
    for (const id of ids) {
      const salt = hotKeySalt(id);
      expect(Number.isInteger(salt)).toBe(true);
      expect(salt).toBeGreaterThanOrEqual(0);
      expect(salt).toBeLessThanOrEqual(9);
    }
  });

  it('spreads 10,000 ids so that each salt receives between 8% and 12%', () => {
    const counts = new Array<number>(10).fill(0);
    for (const id of ids) counts[hotKeySalt(id)]++;
    for (const count of counts) {
      expect(count / ids.length).toBeGreaterThanOrEqual(0.08);
      expect(count / ids.length).toBeLessThanOrEqual(0.12);
    }
  });

  it('the Kafka key is the campaign id and the salt', () => {
    const id = ids[0];
    expect(clickKey('campaign-1', id)).toBe(`campaign-1#${hotKeySalt(id)}`);
  });
});
