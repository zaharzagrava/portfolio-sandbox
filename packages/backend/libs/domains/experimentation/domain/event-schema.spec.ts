import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_EVENT_NAMES,
  INGEST_CODES,
  INGEST_EVENT_NAMES,
  formatStoredTime,
} from '@marketplace-sandbox/contracts';
import {
  ANALYTICS_TOPIC,
  enrichEvent,
  judgeEvent,
  judgeEvents,
  readEnvelope,
} from './event-schema';

interface Vector {
  name: string;
  now: number;
  request: {
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  expect: {
    status: number;
    accepted: number;
    rejected: { index: number; code: string }[];
    stored: Record<string, unknown>[];
  };
}

const VECTORS: Vector[] = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../../contracts/src/analytics/ingest-vectors.json',
    ),
    'utf8',
  ),
);

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0, 0);
const DAY = 86_400_000;
const base = {
  event_id: '0b5f6f0e-1111-4222-8333-444455556666',
  name: 'page_view',
  anonymous_id: 'anon-12345678',
  ts: NOW - 1_000,
};
const judge = (patch: Record<string, unknown>, now = NOW) =>
  judgeEvent({ ...base, ...patch }, now);
const codeOf = (patch: Record<string, unknown>) => {
  const verdict = judge(patch);
  return verdict.ok ? 'accepted' : verdict.code;
};

describe('Client event schema and clock rules', () => {
  it('S39 AS-10: the topic and the closed code list are the ones the contract names', () => {
    expect(ANALYTICS_TOPIC).toBe('analytics.events');
    expect(INGEST_CODES).toEqual([
      'invalid_event_id',
      'unknown_event_name',
      'invalid_anonymous_id',
      'invalid_timestamp',
      'invalid_props',
      'invalid_page',
      'invalid_exposure',
      'forbidden_field',
      'event_too_old',
      'duplicate_in_batch',
    ]);
  });

  describe('shared vectors (the edge worker runs the same file)', () => {
    it.each(VECTORS.map((v) => [v.name, v] as const))(
      'S39 AS-10: vector %s',
      (_name, vector) => {
        const raw =
          vector.request.rawBody !== undefined
            ? safeJson(vector.request.rawBody)
            : vector.request.body;
        const events = readEnvelope(raw);
        if (vector.expect.status === 400) {
          expect(events).toBeNull();
          return;
        }
        expect(events).not.toBeNull();
        const result = judgeEvents(events ?? [], vector.now);
        expect(result.accepted).toEqual(vector.expect.stored);
        expect(result.rejected).toEqual(vector.expect.rejected);
        expect(result.accepted.length).toBe(vector.expect.accepted);
      },
    );

    it('S39 AS-10: the vectors cover every code and both clock limits', () => {
      const codes = new Set(
        VECTORS.flatMap((v) => v.expect.rejected.map((r) => r.code)),
      );
      expect([...codes].sort()).toEqual([...INGEST_CODES].sort());
      expect(VECTORS.length).toBeGreaterThan(60);
    });
  });

  describe('per-event classes', () => {
    it.each([
      ['invalid_event_id', { event_id: 'nope' }],
      ['invalid_event_id', { event_id: undefined }],
      ['unknown_event_name', { name: 'purchase' }],
      ['unknown_event_name', { name: 'login' }],
      ['invalid_anonymous_id', { anonymous_id: 'a'.repeat(7) }],
      ['invalid_anonymous_id', { anonymous_id: 'a'.repeat(65) }],
      ['invalid_anonymous_id', { anonymous_id: 'anon 12345678' }],
      ['invalid_timestamp', { ts: -1 }],
      ['invalid_timestamp', { ts: 1.5 }],
      ['invalid_timestamp', { ts: String(NOW) }],
      ['invalid_props', { props: { a: { b: 1 } } }],
      ['invalid_props', { props: { a: [1] } }],
      ['invalid_props', { props: { 'a b': 1 } }],
      ['invalid_props', { props: { a: 'x'.repeat(501) } }],
      ['invalid_page', { page: 'x'.repeat(501) }],
      ['invalid_exposure', { name: 'exposure', props: { variant: 'a' } }],
      ['forbidden_field', { user_id: 'u1' }],
      ['forbidden_field', { received_at: '2026-01-01 00:00:00.000' }],
      ['forbidden_field', { country: 'DE' }],
      ['forbidden_field', { platform: 'server' }],
      ['event_too_old', { ts: NOW - 8 * DAY }],
    ])('S39 AS-03: %s for %j', (code, patch) => {
      expect(codeOf(patch)).toBe(code);
    });

    it.each([
      ['an id of 8 characters', { anonymous_id: 'a'.repeat(8) }],
      ['an id of 64 characters', { anonymous_id: 'a'.repeat(64) }],
      [
        '30 props',
        { props: Object.fromEntries(range(30).map((i) => [`k${i}`, 'v'])) },
      ],
      ['a prop key of 64 characters', { props: { ['k'.repeat(64)]: 'v' } }],
      ['a prop value of 500 characters', { props: { k: 'v'.repeat(500) } }],
      ['a page of 500 characters', { page: '/'.repeat(500) }],
      ['an unknown extra field', { colour: 'red' }],
    ])('S39 AS-03: %s is accepted', (_label, patch) => {
      expect(codeOf(patch)).toBe('accepted');
    });

    it.each([
      [
        '31 props',
        { props: Object.fromEntries(range(31).map((i) => [`k${i}`, 'v'])) },
      ],
      ['a prop key of 65 characters', { props: { ['k'.repeat(65)]: 'v' } }],
      ['a prop value of 501 characters', { props: { k: 'v'.repeat(501) } }],
    ])('S39 AS-03: %s is invalid_props', (_label, patch) => {
      expect(codeOf(patch)).toBe('invalid_props');
    });

    it.each([
      [
        'a bad id beats a forbidden field',
        { event_id: 'x', user_id: 'u' },
        'invalid_event_id',
      ],
      [
        'a bad timestamp beats bad props',
        { ts: -1, props: { a: [] } },
        'invalid_timestamp',
      ],
      [
        'a forbidden field beats an old event',
        { user_id: 'u', ts: 5 },
        'forbidden_field',
      ],
    ])('S39 AS-03: precedence, %s', (_label, patch, code) => {
      expect(codeOf(patch)).toBe(code);
    });

    it('S39 AS-03: numbers and booleans become strings and a page defaults to empty', () => {
      const verdict = judge({ props: { n: 1.5, t: true, f: false } });
      expect(verdict.ok && verdict.event.props).toEqual({
        n: '1.5',
        t: 'true',
        f: 'false',
      });
      expect(verdict.ok && verdict.event.page).toBe('');
    });
  });

  describe('clock arithmetic', () => {
    it.each([
      ['exactly 7 days old', NOW - 7 * DAY, 'kept', NOW - 7 * DAY],
      ['7 days and 1 ms old', NOW - 7 * DAY - 1, 'event_too_old', null],
      ['exactly 10 minutes ahead', NOW + 600_000, 'kept', NOW + 600_000],
      ['10 minutes and 1 ms ahead', NOW + 600_001, 'kept', NOW],
      ['two days old', NOW - 2 * DAY, 'kept', NOW - 2 * DAY],
      ['a year ahead', NOW + 365 * DAY, 'kept', NOW],
    ])('S39 AS-05: %s', (_label, ts, outcome, storedTs) => {
      const verdict = judge({ ts });
      if (outcome === 'event_too_old') {
        expect(verdict).toEqual({ ok: false, code: 'event_too_old' });
        return;
      }
      expect(verdict.ok && verdict.event.ts).toBe(
        formatStoredTime(storedTs as number),
      );
      expect(verdict.ok && verdict.event.received_at).toBe(
        formatStoredTime(NOW),
      );
    });

    it('S39 AS-01: times are YYYY-MM-DD HH:mm:ss.SSS in UTC', () => {
      expect(formatStoredTime(Date.UTC(2026, 0, 2, 3, 4, 5, 6))).toBe(
        '2026-01-02 03:04:05.006',
      );
    });
  });

  describe('exposure shapes', () => {
    it.each([
      [
        'an experiment exposure',
        { experiment: 'free-shipping', variant: 'free' },
        true,
      ],
      [
        'a flag exposure',
        { flag_key: 'new-checkout', variant: 'on', flag_version: '4' },
        true,
      ],
      [
        'a variant of 32 characters',
        { experiment: 'e', variant: 'v'.repeat(32) },
        true,
      ],
      [
        'a variant of 33 characters',
        { experiment: 'e', variant: 'v'.repeat(33) },
        false,
      ],
      ['an empty variant', { experiment: 'e', variant: '' }, false],
      ['no variant', { experiment: 'e' }, false],
      [
        'experiment and flag_key together',
        { experiment: 'e', flag_key: 'f', variant: 'a', flag_version: '1' },
        false,
      ],
      ['neither experiment nor flag_key', { variant: 'a' }, false],
      ['a flag without flag_version', { flag_key: 'f', variant: 'a' }, false],
      [
        'an extra property',
        { experiment: 'e', variant: 'a', other: 'x' },
        false,
      ],
      ['a numeric variant', { experiment: 'e', variant: 1 }, false],
    ])('S39 AS-26: %s', (_label, props, valid) => {
      expect(codeOf({ name: 'exposure', props })).toBe(
        valid ? 'accepted' : 'invalid_exposure',
      );
    });

    it('S39 AS-26: an exposure without props is invalid_exposure', () => {
      expect(codeOf({ name: 'exposure' })).toBe('invalid_exposure');
    });
  });

  describe('enrichment', () => {
    const accepted = (() => {
      const verdict = judge({});
      if (!verdict.ok) throw new Error('fixture event must be valid');
      return verdict.event;
    })();

    it('S39 AS-11: country needs to be two uppercase letters and platform one of the closed set', () => {
      expect(
        enrichEvent(accepted, { country: 'DE', platform: 'ios' }),
      ).toMatchObject({
        country: 'DE',
        platform: 'ios',
      });
      for (const country of ['de', 'XX', 'T1', 'DEU', ''])
        expect(enrichEvent(accepted, { country }).country).toBe('');
      for (const platform of ['toaster', 'server', '', undefined])
        expect(enrichEvent(accepted, { platform }).platform).toBe('web');
    });

    it('S39 AS-02: user_id is the verified one or empty', () => {
      expect(enrichEvent(accepted, { userId: 'u-1' }).user_id).toBe('u-1');
      expect(enrichEvent(accepted, {}).user_id).toBe('');
    });
  });

  describe('drift guard', () => {
    it('S39 AS-10: the browser contract lists exactly the names the rules accept', () => {
      expect([...CLIENT_EVENT_NAMES].sort()).toEqual(
        [...INGEST_EVENT_NAMES].sort(),
      );
    });
  });
});

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
