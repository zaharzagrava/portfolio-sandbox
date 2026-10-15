import { fingerprint, parseOp } from './sync-ops';

const OP_ID = '0190f3a2-7b1c-7a55-9c3e-1a2b3c4d5e6f';
const PRODUCT = '2f1c7a3e-4d5b-4c6d-8e7f-0a1b2c3d4e5f';
const HLC = '000000000001000-00000-dev-a';
const adjust = (extra: Record<string, unknown> = {}) => ({
  type: 'stock.adjust',
  opId: OP_ID,
  hlc: HLC,
  productId: PRODUCT,
  delta: 3,
  reason: 'received',
  ...extra,
});
const count = (extra: Record<string, unknown> = {}) => ({
  type: 'stock.count',
  opId: OP_ID,
  hlc: HLC,
  productId: PRODUCT,
  counted: 8,
  base: 10,
  ...extra,
});
const update = (
  fields: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: 'product.update',
  opId: OP_ID,
  hlc: HLC,
  productId: PRODUCT,
  fields,
  ...extra,
});

describe('operation schema', () => {
  it.each([
    ['adjust', adjust()],
    ['adjust, negative at the bound', adjust({ delta: -100_000 })],
    ['adjust, positive at the bound', adjust({ delta: 100_000 })],
    ['count', count()],
    ['count at the bound', count({ counted: 1_000_000, base: 1_000_000 })],
    ['count of zero', count({ counted: 0 })],
    ['title only', update({ title: 'Hoodie' })],
    ['price only', update({ priceMinor: 0 })],
    ['all fields', update({ title: 'a', description: '', priceMinor: 450 })],
  ])('S09 AS-22: accepts %s', (_name, raw) => {
    expect(parseOp(raw).ok).toBe(true);
  });

  it.each([
    ['zero delta', adjust({ delta: 0 }), 'delta'],
    ['fractional delta', adjust({ delta: 1.5 }), 'delta'],
    ['delta over the bound', adjust({ delta: 100_001 }), 'delta'],
    ['delta under the bound', adjust({ delta: -100_001 }), 'delta'],
    ['unknown reason', adjust({ reason: 'gift' }), 'reason'],
    ['negative count', count({ counted: -1 }), 'counted'],
    ['negative base', count({ base: -1 }), 'base'],
    ['count over the bound', count({ counted: 1_000_001 }), 'counted'],
    ['base over the bound', count({ base: 1_000_001 }), 'base'],
    ['empty title', update({ title: '' }), 'fields.title'],
    ['long title', update({ title: 'x'.repeat(201) }), 'fields.title'],
    ['negative price', update({ priceMinor: -1 }), 'fields.priceMinor'],
    ['fractional price', update({ priceMinor: 4.5 }), 'fields.priceMinor'],
    ['the legacy price field', update({ price: 450 }), 'fields'],
    ['unknown field', update({ brand: 'x' }), 'fields'],
    ['no field', update({}), 'fields'],
    ['unknown type', { ...adjust(), type: 'stock.set' }, 'type'],
    ['not an object', 'x', ''],
    ['null', null, ''],
  ])('S09 AS-22: rejects %s and names the path', (_name, raw, path) => {
    const parsed = parseOp(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.path)).toContain(path);
  });

  it.each([
    ['shopId', adjust({ shopId: PRODUCT })],
    ['userId', count({ userId: PRODUCT })],
    ['deviceId', update({ title: 'a' }, { deviceId: 'dev-a' })],
  ])('S09 AS-47: a body %s is refused as an unknown field', (key, raw) => {
    const parsed = parseOp(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(JSON.stringify(parsed.issues)).toContain(key);
  });

  it.each([
    ['not a uuid', 'abc'],
    ['uuid v4', '2f1c7a3e-4d5b-4c6d-8e7f-0a1b2c3d4e5f'],
    ['empty', ''],
  ])('S09 AS-22: opId %s is refused', (_name, opId) => {
    expect(parseOp(adjust({ opId })).ok).toBe(false);
  });

  it('S09 AS-04: the fingerprint depends on content and ignores key order', () => {
    const a = parseOp(adjust());
    const b = parseOp({
      reason: 'received',
      delta: 3,
      productId: PRODUCT,
      hlc: HLC,
      opId: OP_ID,
      type: 'stock.adjust',
    });
    const c = parseOp(adjust({ delta: 30 }));
    if (!a.ok || !b.ok || !c.ok) throw new Error('fixture invalid');
    expect(fingerprint(a.op)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(a.op)).toBe(fingerprint(b.op));
    expect(fingerprint(a.op)).not.toBe(fingerprint(c.op));
  });

  it('S09 AS-04: the fingerprint of a field edit ignores the order of its fields', () => {
    const a = parseOp(update({ title: 'a', priceMinor: 5 }));
    const b = parseOp(update({ priceMinor: 5, title: 'a' }));
    if (!a.ok || !b.ok) throw new Error('fixture invalid');
    expect(fingerprint(a.op)).toBe(fingerprint(b.op));
  });
});
