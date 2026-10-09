import { v7 as uuidv7 } from 'uuid';
import {
  eventEnvelopeSchema,
  fixtureItemChangedV1Schema,
  fixtureItemRenamedV1Schema,
} from '@marketplace-sandbox/contracts';
import { eventEnvelopeSchema as reExported } from './event-envelope';

const valid = () => ({
  eventId: uuidv7(),
  type: 'fixture.created',
  version: 1,
  aggregateType: 'fixtures',
  aggregateId: uuidv7(),
  aggregateVersion: 0,
  occurredAt: '2026-10-09T10:00:00.000Z',
  payload: { name: 'a' },
});

describe('S53 envelope contract parity', () => {
  it('S53 AS-108: the backend re-exports the schema of packages/contracts, not a copy', () => {
    expect(reExported).toBe(eventEnvelopeSchema);
  });

  it('S53 AS-108: a conforming envelope parses and keeps exactly the contract fields', () => {
    const parsed = eventEnvelopeSchema.parse({
      ...valid(),
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'aggregateId',
        'aggregateType',
        'aggregateVersion',
        'eventId',
        'occurredAt',
        'payload',
        'traceparent',
        'type',
        'version',
      ].sort(),
    );
  });

  it('S53 AS-108: the old field names are not part of the contract', () => {
    const parsed = eventEnvelopeSchema.safeParse({
      ...valid(),
      eventName: 'x',
      schemaVersion: 1,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('eventName');
    expect(parsed.data).not.toHaveProperty('schemaVersion');
  });

  it.each([
    ['eventId not a UUID', { eventId: 'abc' }],
    ['eventId UUIDv4', { eventId: '3b241101-e2bb-4255-8caf-4136c566a962' }],
    ['type upper case', { type: 'Fixture.Created' }],
    ['type without dot', { type: 'fixture' }],
    ['type with dash', { type: 'fixture.created-now' }],
    ['version 0', { version: 0 }],
    ['version fractional', { version: 1.5 }],
    ['aggregateType empty', { aggregateType: '' }],
    ['aggregateId empty', { aggregateId: '' }],
    ['aggregateVersion negative', { aggregateVersion: -1 }],
    ['aggregateVersion above 2^53-1', { aggregateVersion: 2 ** 53 }],
    ['aggregateVersion fractional', { aggregateVersion: 0.5 }],
    ['occurredAt not ISO', { occurredAt: 'yesterday' }],
    [
      'occurredAt with offset instead of UTC',
      { occurredAt: '2026-10-09T10:00:00+02:00' },
    ],
    ['payload an array', { payload: [] }],
    ['payload a string', { payload: 'x' }],
    ['payload null', { payload: null }],
  ])('S53 AS-108: rejects %s', (_label, override) => {
    expect(
      eventEnvelopeSchema.safeParse({ ...valid(), ...override }).success,
    ).toBe(false);
  });

  it.each([
    ['0', 0],
    ['2^53-1', Number.MAX_SAFE_INTEGER],
  ])('S53 AS-108: accepts aggregateVersion %s', (_label, aggregateVersion) => {
    expect(
      eventEnvelopeSchema.safeParse({ ...valid(), aggregateVersion }).success,
    ).toBe(true);
  });

  it('S53 AS-108: the fixture payload schemas accept their payloads and reject others', () => {
    expect(fixtureItemChangedV1Schema.safeParse({ name: 'a' }).success).toBe(
      true,
    );
    expect(fixtureItemChangedV1Schema.safeParse({}).success).toBe(false);
    expect(fixtureItemRenamedV1Schema.safeParse({ name: 'b' }).success).toBe(
      true,
    );
    expect(fixtureItemRenamedV1Schema.safeParse({ name: 1 }).success).toBe(
      false,
    );
  });
});
