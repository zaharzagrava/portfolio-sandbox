import {
  ASSISTANT_IDEMPOTENCY_KEY_PATTERN,
  assistantIdempotencyKeySchema,
  assistantSendMessageRequestSchema,
} from './send-message.ts';

const ok = (r: { success: boolean }) => r.success;
const fieldsOf = (r: {
  success: boolean;
  error?: { issues: { path: PropertyKey[] }[] };
}) => (r.error?.issues ?? []).map((i) => String(i.path[0]));

describe('S46 send-message contract (parse tests)', () => {
  it('S46 AS-01: a plain text parses and is trimmed', () => {
    const r = assistantSendMessageRequestSchema.safeParse({ text: '  hi  ' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ text: 'hi' });
  });

  it('S46 AS-03: 4000 characters are accepted, 4001 are refused naming text', () => {
    expect(
      ok(assistantSendMessageRequestSchema.safeParse({ text: 'a'.repeat(4000) })),
    ).toBe(true);
    const r = assistantSendMessageRequestSchema.safeParse({
      text: 'a'.repeat(4001),
    });
    expect(r.success).toBe(false);
    expect(fieldsOf(r)).toEqual(['text']);
  });

  it('S46 AS-03: the limit is measured after trimming', () => {
    expect(
      ok(
        assistantSendMessageRequestSchema.safeParse({
          text: ` ${'a'.repeat(4000)} `,
        }),
      ),
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ['text missing', {}],
    ['text empty', { text: '' }],
    ['text only whitespace', { text: ' \n\t ' }],
    ['text not a string', { text: 5 }],
  ])('S46 AS-03: %s is refused naming text', (_n, body) => {
    const r = assistantSendMessageRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
    expect(fieldsOf(r)).toEqual(['text']);
  });

  it.each<[string, Record<string, unknown>]>([
    ['lat without lng', { text: 'hi', lat: 52.5 }],
    ['lng without lat', { text: 'hi', lng: 13.4 }],
    ['lat above 90', { text: 'hi', lat: 90.0001, lng: 0 }],
    ['lat below -90', { text: 'hi', lat: -90.0001, lng: 0 }],
    ['lng above 180', { text: 'hi', lat: 0, lng: 180.0001 }],
    ['lng below -180', { text: 'hi', lat: 0, lng: -180.0001 }],
    ['lat a string', { text: 'hi', lat: '52.5', lng: 13.4 }],
    ['lng null', { text: 'hi', lat: 52.5, lng: null }],
    ['lat NaN', { text: 'hi', lat: Number.NaN, lng: 13.4 }],
  ])('S46 AS-03: %s is refused naming lat or lng', (_n, body) => {
    const r = assistantSendMessageRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
    expect(fieldsOf(r).length).toBeGreaterThan(0);
    expect(fieldsOf(r).every((f) => f === 'lat' || f === 'lng')).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['both at the lower bounds', { text: 'hi', lat: -90, lng: -180 }],
    ['both at the upper bounds', { text: 'hi', lat: 90, lng: 180 }],
    ['both zero', { text: 'hi', lat: 0, lng: 0 }],
    ['a Berlin location', { text: 'hi', lat: 52.5, lng: 13.4 }],
  ])('S46 AS-13: a location with %s is accepted', (_n, body) => {
    expect(ok(assistantSendMessageRequestSchema.safeParse(body))).toBe(true);
  });

  it.each(['model', 'system', 'tools', 'userId', 'stream'])(
    'S46 AS-03: an unknown field %s is refused naming it',
    (field) => {
      const r = assistantSendMessageRequestSchema.safeParse({
        text: 'hi',
        [field]: 'x',
      });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.code).toBe('unrecognized_keys');
      expect(JSON.stringify(r.error?.issues)).toContain(field);
    },
  );

  it('S46 AS-03: an Idempotency-Key of 1 to 128 characters of [A-Za-z0-9_-] is accepted', () => {
    expect(ASSISTANT_IDEMPOTENCY_KEY_PATTERN.test('k1')).toBe(true);
    for (const k of [
      'k',
      'K_1-x',
      'a'.repeat(128),
      '0192b0a0-0000-7000-8000-000000000001',
    ]) {
      expect(ok(assistantIdempotencyKeySchema.safeParse(k))).toBe(true);
    }
  });

  it.each<[string, unknown]>([
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a space', 'a b'],
    ['a dot', 'a.b'],
    ['a slash', 'a/b'],
    ['non-ASCII', 'clé'],
    ['a newline', 'a\nb'],
    ['not a string', 5],
  ])('S46 AS-03: an Idempotency-Key that is %s is refused', (_n, key) => {
    expect(ok(assistantIdempotencyKeySchema.safeParse(key))).toBe(false);
  });
});
