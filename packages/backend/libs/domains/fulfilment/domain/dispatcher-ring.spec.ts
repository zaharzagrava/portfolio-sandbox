import fc from 'fast-check';
import { VIRTUAL_NODES, ownerOf } from './dispatcher-ring';

const CITIES = Array.from({ length: 1000 }, (_, i) => `city-${i}`);
const instances = (n: number) => Array.from({ length: n }, (_, i) => `w-${i}`);

const ownership = (set: string[]) =>
  new Map(CITIES.map((city) => [city, ownerOf(city, set)]));

describe('dispatcher ring', () => {
  it('S20 AS-52: uses 128 virtual nodes per instance', () => {
    expect(VIRTUAL_NODES).toBe(128);
  });

  it('S20 AS-52: ownership is deterministic', () => {
    expect(ownership(instances(5))).toEqual(ownership(instances(5)));
  });

  it('S20 AS-52: ownership does not depend on the order instances are listed', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.constantFrom(...CITIES.slice(0, 50)),
        (set, city) => {
          const shuffled = [...set].reverse();
          expect(ownerOf(city, shuffled)).toBe(ownerOf(city, set));
          expect(set).toContain(ownerOf(city, set));
        },
      ),
    );
  });

  it('S20 AS-52: with 5 instances each owns between 10 % and 30 % of 1 000 cities', () => {
    const counts = new Map<string, number>();
    for (const owner of ownership(instances(5)).values())
      counts.set(owner as string, (counts.get(owner as string) ?? 0) + 1);
    expect(counts.size).toBe(5);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(100);
      expect(count).toBeLessThanOrEqual(300);
    }
  });

  it('S20 AS-52: a 6th instance takes 8 % to 25 % of cities, all to the new one', () => {
    const before = ownership(instances(5));
    const after = ownership(instances(6));
    let moved = 0;
    for (const city of CITIES) {
      if (before.get(city) === after.get(city)) continue;
      moved++;
      expect(after.get(city)).toBe('w-5');
    }
    expect(moved).toBeGreaterThanOrEqual(80);
    expect(moved).toBeLessThanOrEqual(250);
  });

  it('S20 AS-52: removing an instance moves only its own cities', () => {
    const before = ownership(instances(5));
    const after = ownership(instances(5).filter((i) => i !== 'w-2'));
    for (const city of CITIES) {
      if (before.get(city) === 'w-2') expect(after.get(city)).not.toBe('w-2');
      else expect(after.get(city)).toBe(before.get(city));
    }
  });

  it('S20 AS-52: an empty instance set has no owner', () => {
    expect(ownerOf('berlin', [])).toBeNull();
  });

  it('S20 AS-52: a single instance owns every city', () => {
    for (const city of CITIES.slice(0, 20))
      expect(ownerOf(city, ['only'])).toBe('only');
  });

  it('S20 AS-52: a duplicated instance id counts once', () => {
    expect(ownerOf('berlin', ['a', 'b', 'a'])).toBe(
      ownerOf('berlin', ['a', 'b']),
    );
  });
});
