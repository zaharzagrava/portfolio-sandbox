import { HashRing } from './hash-ring';

/** Routing for every collab connection depends on it; pure → unit spec. */
describe('HashRing', () => {
  const keys = Array.from({ length: 20_000 }, (_, i) => `draft-${i}`);

  it('spreads keys evenly across instances (virtual nodes)', () => {
    const ring = new HashRing(['a', 'b', 'c', 'd', 'e']);
    const counts = new Map<string, number>();
    for (const k of keys) counts.set(ring.nodeFor(k)!, (counts.get(ring.nodeFor(k)!) ?? 0) + 1);
    for (const count of counts.values()) expect(Math.abs(count - 4_000)).toBeLessThan(4_000 * 0.15);
  });

  it('adding an instance moves only ~1/N of the keys, all of them to the new instance', () => {
    const before = new HashRing(['a', 'b', 'c', 'd']);
    const after = new HashRing(['a', 'b', 'c', 'd', 'e']);
    const moved = keys.filter((k) => before.nodeFor(k) !== after.nodeFor(k));
    expect(moved.length / keys.length).toBeGreaterThan(0.12);
    expect(moved.length / keys.length).toBeLessThan(0.28); // ideal 1/5 = 0.2
    expect(moved.every((k) => after.nodeFor(k) === 'e')).toBe(true);
  });

  it('is deterministic regardless of node order; empty ring routes nowhere', () => {
    expect(new HashRing(['x', 'y']).nodeFor('k')).toBe(new HashRing(['y', 'x']).nodeFor('k'));
    expect(new HashRing([]).nodeFor('k')).toBeNull();
  });
});
