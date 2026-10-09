import { z } from 'zod';
import { FakeClock } from '@app/common/core/clock';
import { eventEnvelopeSchema } from './event-envelope';
import { defineEvent, useEventClock } from './define-event';
import {
  DuplicateEventDefinitionError,
  EventTooLargeError,
  InvalidAggregateVersionError,
  InvalidEventPayloadError,
  InvalidEventTypeError,
} from './event-errors';

const schema = z.object({
  name: z.string().min(1),
  nested: z.object({ qty: z.number().int() }).optional(),
});
let seq = 0;
/** A fresh type per call: the (type, version) registry is process-wide. */
const freshType = () => `defspec.item_${seq++}`;
const AGG = '00000000-0000-7000-8000-000000000001';

describe('S53 event definitions', () => {
  const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));
  beforeAll(() => useEventClock(clock));

  it('S53 AS-01: create builds the exact envelope with a UUIDv7 id and the injected clock', () => {
    const def = defineEvent(freshType(), 'defspec', 1, schema);
    const event = def.create(AGG, 4, { name: 'a' });
    expect(eventEnvelopeSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      type: def.type,
      version: 1,
      aggregateType: 'defspec',
      aggregateId: AGG,
      aggregateVersion: 4,
      occurredAt: '2026-10-09T10:00:00.000Z',
      payload: { name: 'a' },
    });
    expect(def.topic).toBe('defspec.events');
  });

  it('S53 AS-01: an explicit occurredAt wins over the clock', () => {
    const def = defineEvent(freshType(), 'defspec', 1, schema);
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(def.create(AGG, 0, { name: 'a' }, at).occurredAt).toBe(
      at.toISOString(),
    );
  });

  it.each([
    ['missing required field', {}, 'name'],
    ['wrong type', { name: 5 }, 'name'],
    ['nested wrong type', { name: 'a', nested: { qty: 'x' } }, 'nested.qty'],
  ])(
    'S53 AS-04: %s throws InvalidEventPayloadError naming the path, never the value',
    (_label, payload, path) => {
      const def = defineEvent(freshType(), 'defspec', 1, schema);
      let error: unknown;
      try {
        def.create(AGG, 1, payload as never);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(InvalidEventPayloadError);
      const message = (error as Error).message;
      expect(message).toContain(path);
      expect(message).not.toContain('"x"');
      expect(message).toContain(def.type);
    },
  );

  it('S53 AS-04: the error never carries the offending value even in a string field', () => {
    const def = defineEvent(
      freshType(),
      'defspec',
      1,
      z.object({ n: z.number() }),
    );
    try {
      def.create(AGG, 1, { n: 'secret-token-123' } as never);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidEventPayloadError);
      expect(JSON.stringify(e)).not.toContain('secret-token-123');
      expect((e as Error).message).not.toContain('secret-token-123');
    }
  });

  it.each([
    ['upper case', 'Orders.Paid'],
    ['no dot', 'orderpaid'],
    ['leading dot', '.order_paid'],
    ['dash', 'orders.order-paid'],
    ['space', 'orders. paid'],
    ['empty', ''],
    ['trailing dot', 'orders.'],
    ['starts with digit', '1orders.paid'],
  ])('S53 AS-10: type with %s is rejected at registration', (_label, type) => {
    expect(() => defineEvent(type, 'defspec', 1, schema)).toThrow(
      InvalidEventTypeError,
    );
  });

  it.each([
    ['two segments', 'okspeca.b'],
    ['underscore in the last segment', 'okspecb.b_c'],
    ['three segments', 'okspecc.sub.item_created'],
  ])('S53 AS-10: %s is accepted', (_label, type) => {
    expect(defineEvent(type, 'defspec', 1, schema).type).toBe(type);
  });

  it('S53 AS-10: a duplicate (type, version) is rejected, a new version of the same type is not', () => {
    const type = freshType();
    defineEvent(type, 'defspec', 1, schema);
    expect(() => defineEvent(type, 'defspec', 1, schema)).toThrow(
      DuplicateEventDefinitionError,
    );
    expect(() => defineEvent(type, 'defspec', 2, schema)).not.toThrow();
  });

  it.each([0, -1, 1.5])('S53 AS-10: contract version %s is rejected', (v) => {
    expect(() => defineEvent(freshType(), 'defspec', v, schema)).toThrow(
      InvalidEventTypeError,
    );
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['above 2^53-1', 2 ** 53],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'S53 AS-10: aggregateVersion %s throws and creates nothing',
    (_label, v) => {
      const def = defineEvent(freshType(), 'defspec', 1, schema);
      expect(() => def.create(AGG, v, { name: 'a' })).toThrow(
        InvalidAggregateVersionError,
      );
    },
  );

  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    'S53 AS-10: aggregateVersion %s is accepted',
    (v) => {
      const def = defineEvent(freshType(), 'defspec', 1, schema);
      expect(def.create(AGG, v, { name: 'a' }).aggregateVersion).toBe(v);
    },
  );

  it('S53 AS-07: an envelope above 256 KiB throws EventTooLargeError with limit and actual size', () => {
    const def = defineEvent(
      freshType(),
      'defspec',
      1,
      z.object({ blob: z.string() }),
    );
    const exactly = (n: number) => {
      const empty = JSON.stringify(def.create(AGG, 1, { blob: '' })).length;
      return 'x'.repeat(n - empty);
    };
    expect(() =>
      def.create(AGG, 1, { blob: exactly(256 * 1024) }),
    ).not.toThrow();
    let error: unknown;
    try {
      def.create(AGG, 1, { blob: exactly(256 * 1024 + 1) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EventTooLargeError);
    expect((error as Error).message).toContain('262144');
    expect((error as Error).message).toContain('262145');
  });

  it("S53 AS-12: carries defaults to 'delta' and records an explicit marker", () => {
    expect(defineEvent(freshType(), 'defspec', 1, schema).carries).toBe(
      'delta',
    );
    expect(
      defineEvent(freshType(), 'defspec', 1, schema, { carries: 'state' })
        .carries,
    ).toBe('state');
  });

  it('S53 AS-10: match narrows by (type, version) and returns null for others', () => {
    const type = freshType();
    const v1 = defineEvent(type, 'defspec', 1, schema);
    const v2 = defineEvent(type, 'defspec', 2, z.object({ title: z.string() }));
    const event = v1.create(AGG, 1, { name: 'a' });
    expect(v1.match(event)).toEqual(event);
    expect(v2.match(event)).toBeNull();
    expect(v1.match({ ...event, type: 'other.thing' })).toBeNull();
  });

  it('S53 AS-04: match validates the payload of a matching envelope', () => {
    const def = defineEvent(freshType(), 'defspec', 1, schema);
    const event = def.create(AGG, 1, { name: 'a' });
    expect(() => def.match({ ...event, payload: {} })).toThrow(
      InvalidEventPayloadError,
    );
  });
});
