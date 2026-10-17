import { HashRing } from './hash-ring';

/** Routing for every collab connection depends on it; pure → unit spec (S06 AS-45, pattern P1105). */
describe('HashRing', () => {
  const keys = Array.from({ length: 10_000 }, (_, i) => `draft-${i}`);
  const owners = (ring: HashRing) => keys.map((k) => ring.nodeFor(k));

  it('S06 AS-45: every process names the same owner for every draft id, whatever the order of the member list', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const reference = owners(new HashRing(nodes));
    for (const order of [
      [...nodes].reverse(),
      ['c', 'a', 'e', 'b', 'd'],
      ['e', 'd', 'c', 'b', 'a'],
    ])
      expect(owners(new HashRing(order))).toEqual(reference);
  });

  it('S06 AS-45: with 5 instances and 10,000 ids no instance owns more than 115% of the mean', () => {
    const ring = new HashRing(['a', 'b', 'c', 'd', 'e']);
    const counts = new Map<string, number>();
    for (const owner of owners(ring))
      counts.set(owner!, (counts.get(owner!) ?? 0) + 1);
    expect(counts.size).toBe(5);
    for (const count of counts.values())
      expect(count).toBeLessThanOrEqual((keys.length / 5) * 1.15);
  });

  it('S06 AS-45: a 6th instance takes at most 1/6 + 5% of the ids and every moved id goes to it', () => {
    const before = new HashRing(['a', 'b', 'c', 'd', 'e']);
    const after = new HashRing(['a', 'b', 'c', 'd', 'e', 'f']);
    const moved = keys.filter((k) => before.nodeFor(k) !== after.nodeFor(k));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length / keys.length).toBeLessThanOrEqual(1 / 6 + 0.05);
    expect(moved.every((k) => after.nodeFor(k) === 'f')).toBe(true);
  });

  it('S06 AS-45: when an instance leaves only its own ids move', () => {
    const before = new HashRing(['a', 'b', 'c', 'd', 'e']);
    const after = new HashRing(['a', 'b', 'c', 'd']);
    const moved = keys.filter((k) => before.nodeFor(k) !== after.nodeFor(k));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((k) => before.nodeFor(k) === 'e')).toBe(true);
  });

  it('S06 AS-45: an empty ring has no owner', () => {
    const ring = new HashRing([]);
    expect(ring.nodeFor('k')).toBeNull();
    expect(ring.size).toBe(0);
  });
});
