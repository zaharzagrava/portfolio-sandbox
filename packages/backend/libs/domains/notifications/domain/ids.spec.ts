import { types } from 'cassandra-driver';
import { deliveryIdFor, inboxItemIdFor } from './ids';

describe('S28 AS-02: deterministic identifiers', () => {
  const at = new Date('2026-10-13T10:00:00.123Z');

  it('S28 AS-02: the same identity gives the same ids, another channel or identity another', () => {
    expect(deliveryIdFor('E1|U1', 'email')).toBe(
      deliveryIdFor('E1|U1', 'email'),
    );
    expect(deliveryIdFor('E1|U1', 'email')).not.toBe(
      deliveryIdFor('E1|U1', 'push'),
    );
    expect(deliveryIdFor('E1|U1', 'email')).not.toBe(
      deliveryIdFor('E1|U2', 'email'),
    );
    expect(deliveryIdFor('E1|U1', 'email')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('S28 AS-02: the inbox id is a time-UUID of the event time, stable per identity', () => {
    const id = inboxItemIdFor('E1|U1', at);
    expect(id).toBe(inboxItemIdFor('E1|U1', at));
    expect(id).not.toBe(inboxItemIdFor('E2|U1', at));
    expect(types.TimeUuid.fromString(id).getDate()).toEqual(at);
    expect(id[14]).toBe('1');
  });

  it('S28 AS-02: later events sort after earlier ones', () => {
    const a = types.TimeUuid.fromString(inboxItemIdFor('x', new Date(1_000)));
    const b = types.TimeUuid.fromString(inboxItemIdFor('y', new Date(2_000)));
    expect(a.getDate().getTime()).toBeLessThan(b.getDate().getTime());
  });
});
