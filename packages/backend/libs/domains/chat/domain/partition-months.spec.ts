import {
  monthBounds,
  monthPartitionName,
  partitionMonths,
} from './partition-months';

const d = (s: string) => new Date(s);

describe('S24 history partitions', () => {
  it('S24 AS-29: current month and the next three exist, when no older message exists', () => {
    expect(partitionMonths(null, d('2030-01-15T10:00:00Z'))).toEqual([
      '2030-01',
      '2030-02',
      '2030-03',
      '2030-04',
    ]);
  });

  it('S24 AS-28: months run from the oldest message to current + 3, across a year end', () => {
    expect(
      partitionMonths(d('2029-10-31T23:59:59Z'), d('2030-01-01T00:00:00Z')),
    ).toEqual([
      '2029-10',
      '2029-11',
      '2029-12',
      '2030-01',
      '2030-02',
      '2030-03',
      '2030-04',
    ]);
  });

  it('S24 AS-29: months are UTC, never local time', () => {
    // 2030-01-31 23:30 UTC-5 is already February in UTC
    expect(partitionMonths(null, d('2030-02-01T04:30:00Z'))[0]).toBe('2030-02');
    expect(partitionMonths(null, d('2030-01-31T23:59:59.999Z'))[0]).toBe(
      '2030-01',
    );
  });

  it('S24 AS-29: an oldest month after now is ignored', () => {
    expect(
      partitionMonths(d('2031-01-01T00:00:00Z'), d('2030-01-15T00:00:00Z')),
    ).toHaveLength(4);
  });

  it('S24 AS-29: the look-ahead is configurable', () => {
    expect(partitionMonths(null, d('2030-11-01T00:00:00Z'), 2)).toEqual([
      '2030-11',
      '2030-12',
      '2031-01',
    ]);
  });

  it('S24 AS-28: names and bounds are half-open UTC months', () => {
    expect(monthPartitionName('2030-02')).toBe('ChatMessage_2030_02');
    expect(monthBounds('2030-12')).toEqual({
      from: '2030-12-01T00:00:00.000Z',
      to: '2031-01-01T00:00:00.000Z',
    });
    expect(monthBounds('2030-02')).toEqual({
      from: '2030-02-01T00:00:00.000Z',
      to: '2030-03-01T00:00:00.000Z',
    });
  });
});
