import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { routeEnvelope } from './routing';
import { HandledEvent } from './projector';

const V1 = defineEvent(
  'chain.renamed',
  'chain',
  1,
  z.object({ name: z.string() }),
);
const V2 = defineEvent(
  'chain.renamed',
  'chain',
  2,
  z.object({ title: z.string() }),
);
const V3 = defineEvent(
  'chain.renamed',
  'chain',
  3,
  z.object({ title: z.string(), tags: z.array(z.string()) }),
);
const Other = defineEvent(
  'chain.other',
  'chain',
  1,
  z.object({ x: z.number() }),
);

const envelope = (
  type: string,
  version: number,
  payload: Record<string, unknown>,
): EventEnvelope => ({
  eventId: '01a12118-0000-7000-8000-000000000001',
  type,
  version,
  aggregateType: 'chain',
  aggregateId: 'a-1',
  aggregateVersion: 1,
  occurredAt: '2026-10-09T10:00:00.000Z',
  payload,
});

const handlesV3: HandledEvent[] = [
  {
    event: V3,
    upgradeFrom: [
      { version: 1, upcast: (p) => ({ title: (p as { name: string }).name }) },
      { version: 2, upcast: (p) => ({ ...(p as object), tags: [] }) },
    ],
  },
  { event: Other },
];

describe('S53 contract version routing and upgrade chain', () => {
  it.each([
    ['v3 as is', 3, { title: 'T', tags: ['a'] }, { title: 'T', tags: ['a'] }],
    ['v2 → v3', 2, { title: 'T' }, { title: 'T', tags: [] }],
    ['v1 → v2 → v3', 1, { name: 'N' }, { title: 'N', tags: [] }],
  ])(
    'S53 AS-54: %s is applied with the same shape as a native v3',
    (_label, version, payload, expected) => {
      const result = routeEnvelope(
        handlesV3,
        envelope('chain.renamed', version, payload),
      );
      expect(result).toMatchObject({ kind: 'handle', payload: expected });
      if (result.kind === 'handle') {
        expect(result.event.type).toBe('chain.renamed');
        expect(result.envelope.version).toBe(3);
      }
    },
  );

  it('S53 AS-54: an upgraded event carries the target version and keeps every other envelope field', () => {
    const original = envelope('chain.renamed', 1, { name: 'N' });
    const result = routeEnvelope(handlesV3, original);
    expect(result.kind).toBe('handle');
    if (result.kind === 'handle')
      expect(result.envelope).toEqual({
        ...original,
        version: 3,
        payload: { title: 'N', tags: [] },
      });
  });

  it('S53 AS-53: a version above the highest handled one is rejected UNSUPPORTED_VERSION', () => {
    expect(
      routeEnvelope(handlesV3, envelope('chain.renamed', 4, { title: 'T' })),
    ).toMatchObject({
      kind: 'reject',
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('S53 AS-54: a missing upgrade step is rejected UNSUPPORTED_VERSION naming the version', () => {
    const missingStep: HandledEvent[] = [
      {
        event: V3,
        upgradeFrom: [
          { version: 2, upcast: (p) => ({ ...(p as object), tags: [] }) },
        ],
      },
    ];
    const result = routeEnvelope(
      missingStep,
      envelope('chain.renamed', 1, { name: 'N' }),
    );
    expect(result).toMatchObject({
      kind: 'reject',
      code: 'UNSUPPORTED_VERSION',
    });
    if (result.kind === 'reject') expect(result.reason).toMatch(/version 1/);
  });

  it('S53 AS-52: a type the consumer does not handle is skipped, not rejected', () => {
    expect(routeEnvelope(handlesV3, envelope('chain.unknown', 1, {}))).toEqual({
      kind: 'skip',
    });
  });

  it('S53 AS-52: a consumer with several native versions routes each to its own schema', () => {
    const both: HandledEvent[] = [{ event: V1 }, { event: V2 }];
    expect(
      routeEnvelope(both, envelope('chain.renamed', 1, { name: 'N' })),
    ).toMatchObject({ kind: 'handle' });
    expect(
      routeEnvelope(both, envelope('chain.renamed', 2, { title: 'T' })),
    ).toMatchObject({ kind: 'handle' });
    expect(
      routeEnvelope(both, envelope('chain.renamed', 3, { title: 'T' })),
    ).toMatchObject({
      kind: 'reject',
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('S53 AS-51: a payload failing its schema is INVALID_PAYLOAD with the failing paths and never the values', () => {
    const result = routeEnvelope(
      handlesV3,
      envelope('chain.renamed', 3, { title: 123, tags: ['ok', 7] }),
    );
    expect(result).toMatchObject({ kind: 'reject', code: 'INVALID_PAYLOAD' });
    if (result.kind === 'reject') {
      expect(result.reason).toContain('title');
      expect(result.reason).toContain('tags.1');
      expect(result.reason).not.toContain('123');
    }
  });

  it('S53 AS-51: a payload that only fails after an upgrade is INVALID_PAYLOAD too', () => {
    const result = routeEnvelope(
      handlesV3,
      envelope('chain.renamed', 1, { name: 42 }),
    );
    expect(result).toMatchObject({ kind: 'reject', code: 'INVALID_PAYLOAD' });
  });

  it('S53 AS-54: an upcast that throws is INVALID_PAYLOAD naming the step, not the error text', () => {
    const throwing: HandledEvent[] = [
      {
        event: V2,
        upgradeFrom: [
          {
            version: 1,
            upcast: () => {
              throw new Error('secret-detail-9');
            },
          },
        ],
      },
    ];
    const result = routeEnvelope(
      throwing,
      envelope('chain.renamed', 1, { name: 'N' }),
    );
    expect(result).toMatchObject({ kind: 'reject', code: 'INVALID_PAYLOAD' });
    if (result.kind === 'reject') {
      expect(result.reason).toMatch(/version 1/);
      expect(result.reason).not.toContain('secret-detail-9');
    }
  });

  it('S53 AS-55: an aggregate id that fails the declared schema is INVALID_AGGREGATE_ID', () => {
    const result = routeEnvelope(
      [{ event: V3 }],
      {
        ...envelope('chain.renamed', 3, { title: 'T', tags: [] }),
        aggregateId: 'not-a-uuid',
      },
      z.uuid(),
    );
    expect(result).toMatchObject({
      kind: 'reject',
      code: 'INVALID_AGGREGATE_ID',
    });
    if (result.kind === 'reject')
      expect(result.reason).not.toContain('not-a-uuid');
  });

  it('S53 AS-55: an unknown type is skipped before its aggregate id is checked', () => {
    expect(
      routeEnvelope(
        handlesV3,
        { ...envelope('chain.unknown', 1, {}), aggregateId: 'not-a-uuid' },
        z.uuid(),
      ),
    ).toEqual({ kind: 'skip' });
  });
});
