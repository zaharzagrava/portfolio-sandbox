import { canAdvance, newSnapshotVersion } from './snapshot-pointer';

describe('snapshot pointer rule', () => {
  it.each([
    [null, '2026-10-10T10-00-00-000Z-aaaa', true],
    ['2026-10-10T10-00-00-000Z-aaaa', '2026-10-10T11-00-00-000Z-aaaa', true],
    ['2026-10-10T10-00-00-000Z-aaaa', '2026-10-10T10-00-00-000Z-aaab', true],
    ['2026-10-10T10-00-00-000Z-aaaa', '2026-10-10T10-00-00-000Z-aaaa', false],
    ['2026-10-10T11-00-00-000Z-aaaa', '2026-10-10T10-00-00-000Z-ffff', false],
  ])('S33 AS-39: from %s to %s → %s', (current, next, expected) => {
    expect(canAdvance(current, next)).toBe(expected);
  });

  it('S33 AS-39: versions are sortable UTC timestamps that sort in clock order', () => {
    const a = newSnapshotVersion(new Date('2026-10-10T09:59:59.999Z'), 'ffff');
    const b = newSnapshotVersion(new Date('2026-10-10T10:00:00.000Z'), '0000');
    expect(a).toBe('2026-10-10T09-59-59-999Z-ffff');
    expect(canAdvance(a, b)).toBe(true);
    expect(canAdvance(b, a)).toBe(false);
  });
});
