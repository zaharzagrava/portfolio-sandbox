import fc from 'fast-check';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { coalesceLatest } from './coalesce';

const event = (
  aggregateId: string,
  aggregateVersion: number,
  aggregateType = 'agg',
): EventEnvelope => ({
  eventId: `e-${aggregateType}-${aggregateId}-${aggregateVersion}`,
  type: 'agg.changed',
  version: 1,
  aggregateType,
  aggregateId,
  aggregateVersion,
  occurredAt: '2026-10-09T10:00:00.000Z',
  payload: {},
});

describe('S53 coalescing', () => {
  it('S53 AS-40: thirty events of one aggregate become the one with version 30', () => {
    const events = Array.from({ length: 30 }, (_, i) => event('a', i + 1));
    const result = coalesceLatest(events);
    expect(result).toHaveLength(1);
    expect(result[0].aggregateVersion).toBe(30);
  });

  it('S53 AS-40: delivered in any order, the highest version wins', () => {
    const result = coalesceLatest([
      event('a', 3),
      event('a', 30),
      event('a', 7),
    ]);
    expect(result.map((e) => e.aggregateVersion)).toEqual([30]);
  });

  it('S53 AS-40: aggregates of different types with the same id are separate keys', () => {
    const result = coalesceLatest([
      event('a', 1, 'x'),
      event('a', 2, 'y'),
      event('a', 3, 'x'),
    ]);
    expect(
      result.map((e) => `${e.aggregateType}:${e.aggregateVersion}`),
    ).toEqual(['x:3', 'y:2']);
  });

  it('S53 AS-40: events of different aggregates keep the order in which the aggregates first appeared', () => {
    const result = coalesceLatest([
      event('b', 1),
      event('a', 1),
      event('b', 2),
      event('c', 1),
    ]);
    expect(result.map((e) => `${e.aggregateId}:${e.aggregateVersion}`)).toEqual(
      ['b:2', 'a:1', 'c:1'],
    );
  });

  it('S53 AS-40: an empty batch stays empty', () => {
    expect(coalesceLatest([])).toEqual([]);
  });

  it('S53 AS-40: the result holds exactly one event per aggregate, the per-aggregate maximum version (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.constantFrom('a', 'b', 'c', 'd'),
            version: fc.integer({ min: 0, max: 1_000 }),
          }),
          { maxLength: 80 },
        ),
        (items) => {
          const events = items.map((i, n) => ({
            ...event(i.id, i.version),
            eventId: `e${n}`,
          }));
          const result = coalesceLatest(events);
          const maxima = new Map<string, number>();
          for (const e of events)
            maxima.set(
              e.aggregateId,
              Math.max(maxima.get(e.aggregateId) ?? -1, e.aggregateVersion),
            );
          expect(result).toHaveLength(maxima.size);
          for (const e of result)
            expect(e.aggregateVersion).toBe(maxima.get(e.aggregateId));
          return true;
        },
      ),
    );
  });
});
