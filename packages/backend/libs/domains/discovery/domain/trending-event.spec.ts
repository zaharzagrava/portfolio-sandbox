import { normalise, parseStoredTime } from './trending-event';

const PRODUCT = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const weights = { weightView: 1, weightCart: 5 };

const event = (patch: Record<string, unknown> = {}) => ({
  event_id: '0b0f6f3e-0c4d-4b8b-9d7d-5e0d2f7d9a11',
  name: 'product_view' as const,
  anonymous_id: 'anon-12345678',
  user_id: '',
  ts: '2026-10-10 12:00:30.000',
  received_at: '2026-10-10 12:00:31.000',
  props: { product_id: PRODUCT, category: 'audio' } as Record<string, string>,
  ...patch,
});

const at = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

describe('S35 event normalisation (U5)', () => {
  it.each([
    ['product_view', 1],
    ['add_to_cart', 5],
  ])('S35 AS-16: %s counts with weight %i', (name, weight) => {
    const out = normalise(event({ name }), weights);
    expect(out).toMatchObject({ kind: 'count', weight, productId: PRODUCT });
  });

  it('S35 AS-16: weights come from the settings', () => {
    expect(
      normalise(event({ name: 'add_to_cart' }), {
        weightView: 2,
        weightCart: 9,
      }),
    ).toMatchObject({ kind: 'count', weight: 9 });
  });

  it.each(['page_view', 'search', 'checkout_step', 'exposure', 'click'])(
    'S35 AS-16: %s is ignored',
    (name) => {
      expect(normalise(event({ name }), weights)).toEqual({
        kind: 'ignored',
        eventTimeMs: at('2026-10-10 12:00:30.000'),
        receivedAtMs: at('2026-10-10 12:00:31.000'),
      });
    },
  );

  it('S35 AS-30: an ignored name with an invalid time is still invalid (dead-lettered)', () => {
    expect(
      normalise(event({ name: 'page_view', ts: 'nope' }), weights),
    ).toMatchObject({ kind: 'invalid' });
  });

  it.each([
    ['no props at all', {}],
    ['product_id missing', { category: 'audio' }],
    ['product_id empty', { product_id: '' }],
  ])('S35 AS-16: a product event with %s is ignored', (_n, props) => {
    expect(normalise(event({ props }), weights)).toMatchObject({
      kind: 'ignored',
    });
  });

  it('S35 AS-30: a product_id that is not a UUID is invalid (dead-lettered), not ignored', () => {
    expect(
      normalise(event({ props: { product_id: 'abc' } }), weights),
    ).toMatchObject({ kind: 'invalid' });
  });

  it.each([
    ['audio', 'audio', false],
    ['a'.repeat(40), 'a'.repeat(40), false],
    ['Audio', null, true],
    ['a b', null, true],
    ['a:b', null, true],
    ['{x}', null, true],
    ['a'.repeat(41), null, true],
    ['', null, true],
  ])(
    'S35 AS-27: category %j is %j (rejected: %s)',
    (category, expected, rejected) => {
      const out = normalise(
        event({ props: { product_id: PRODUCT, category } }),
        weights,
      );
      expect(out).toMatchObject({
        kind: 'count',
        category: expected,
        categoryRejected: rejected,
      });
    },
  );

  it('S35 AS-27: no category at all is not a rejection', () => {
    expect(
      normalise(event({ props: { product_id: PRODUCT } }), weights),
    ).toMatchObject({ kind: 'count', category: null, categoryRejected: false });
  });

  it('S35 AS-20: the event time is the earlier of ts and received_at', () => {
    expect(
      normalise(
        event({
          ts: '2026-10-10 13:30:00.000',
          received_at: '2026-10-10 12:00:05.000',
        }),
        weights,
      ),
    ).toMatchObject({
      eventTimeMs: at('2026-10-10 12:00:05.000'),
      receivedAtMs: at('2026-10-10 12:00:05.000'),
    });
    expect(
      normalise(
        event({
          ts: '2026-10-10 12:00:10.000',
          received_at: '2026-10-10 12:00:15.500',
        }),
        weights,
      ),
    ).toMatchObject({
      eventTimeMs: at('2026-10-10 12:00:10.000'),
      receivedAtMs: at('2026-10-10 12:00:15.500'),
    });
  });

  it('S35 AS-30: invalid timestamps are invalid, never NaN', () => {
    for (const patch of [
      { ts: '2026-13-10 12:00:30.000' },
      { ts: '2026-02-30 12:00:30.000' },
      { received_at: '2026-10-10 25:00:30.000' },
      { received_at: '2026-10-10 12:61:30.000' },
    ])
      expect(normalise(event(patch), weights)).toMatchObject({
        kind: 'invalid',
      });
  });

  it('S35 AS-30: the strict parser accepts only YYYY-MM-DD HH:mm:ss.SSS', () => {
    expect(parseStoredTime('2026-10-10 12:00:30.250')).toBe(
      Date.UTC(2026, 9, 10, 12, 0, 30, 250),
    );
    for (const bad of [
      '2026-10-10T12:00:30.250Z',
      '2026-10-10 12:00:30',
      '',
      'x',
    ])
      expect(parseStoredTime(bad)).toBeNull();
  });

  it('S35 AS-22: carries the identifiers the caps need and nothing else', () => {
    const out = normalise(event(), weights);
    expect(out).toMatchObject({
      kind: 'count',
      eventId: '0b0f6f3e-0c4d-4b8b-9d7d-5e0d2f7d9a11',
      visitorId: 'anon-12345678',
      name: 'product_view',
    });
  });
});
