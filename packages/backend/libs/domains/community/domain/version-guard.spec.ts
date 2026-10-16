import { applyProductEvent, type ProductCopy } from './version-guard';

const copy = (over: Partial<ProductCopy> = {}): ProductCopy => ({
  productId: 'p1',
  shopId: 's1',
  title: 'Lamp',
  priceMinor: 1000,
  currency: 'USD',
  status: 'ACTIVE',
  isSandbox: false,
  productVersion: 3,
  ...over,
});

describe('product copy version guard', () => {
  it('S26 AS-17: the first event creates the copy', () => {
    const r = applyProductEvent(null, { kind: 'snapshot', copy: copy() });
    expect(r.applied).toBe(true);
    expect(r.copy).toEqual(copy());
  });

  it('S26 AS-17: a newer version replaces the copy', () => {
    const r = applyProductEvent(copy(), {
      kind: 'snapshot',
      copy: copy({ productVersion: 4, priceMinor: 900 }),
    });
    expect(r.applied).toBe(true);
    expect(r.copy?.priceMinor).toBe(900);
    expect(r.copy?.productVersion).toBe(4);
  });

  it('S26 AS-17: an older or equal version is ignored and the stored copy is unchanged', () => {
    const current = copy({ productVersion: 5, status: 'ARCHIVED' });
    for (const v of [4, 5]) {
      const r = applyProductEvent(current, {
        kind: 'snapshot',
        copy: copy({ productVersion: v }),
      });
      expect(r.applied).toBe(false);
      expect(r.copy).toEqual(current);
    }
  });

  it('S26 AS-17: archived (v5) before created (v4) keeps v5 ARCHIVED', () => {
    const first = applyProductEvent(null, {
      kind: 'snapshot',
      copy: copy({ productVersion: 5, status: 'ARCHIVED' }),
    });
    const late = applyProductEvent(first.copy, {
      kind: 'snapshot',
      copy: copy({ productVersion: 4 }),
    });
    expect(late.applied).toBe(false);
    expect(late.copy?.status).toBe('ARCHIVED');
    expect(late.copy?.productVersion).toBe(5);
  });

  it('S26 AS-38: archive then restore moves the status both ways with rising versions', () => {
    const archived = applyProductEvent(copy(), {
      kind: 'snapshot',
      copy: copy({ productVersion: 4, status: 'ARCHIVED' }),
    });
    const restored = applyProductEvent(archived.copy, {
      kind: 'snapshot',
      copy: copy({ productVersion: 5, status: 'ACTIVE' }),
    });
    expect(restored.copy?.status).toBe('ACTIVE');
  });

  it('S26 AS-17: a deletion arriving first leaves a tombstone that older events cannot undo', () => {
    const deleted = applyProductEvent(null, {
      kind: 'deleted',
      productId: 'p1',
      shopId: 's1',
      productVersion: 7,
    });
    expect(deleted.applied).toBe(true);
    expect(deleted.copy?.status).toBe('DELETED');
    expect(deleted.copy?.productVersion).toBe(7);
    const late = applyProductEvent(deleted.copy, {
      kind: 'snapshot',
      copy: copy({ productVersion: 4 }),
    });
    expect(late.applied).toBe(false);
    expect(late.copy?.status).toBe('DELETED');
  });

  it('S26 AS-38: deletion is final even for a (corrupt) newer snapshot', () => {
    const deleted = applyProductEvent(copy(), {
      kind: 'deleted',
      productId: 'p1',
      shopId: 's1',
      productVersion: 6,
    });
    expect(deleted.copy).toMatchObject({
      status: 'DELETED',
      title: 'Lamp',
      productVersion: 6,
    });
    const after = applyProductEvent(deleted.copy, {
      kind: 'snapshot',
      copy: copy({ productVersion: 9 }),
    });
    expect(after.applied).toBe(false);
    expect(after.copy?.status).toBe('DELETED');
  });

  it('S26 AS-15: the same event applied twice changes nothing the second time', () => {
    const event = {
      kind: 'snapshot' as const,
      copy: copy({ productVersion: 4 }),
    };
    const once = applyProductEvent(copy(), event);
    const twice = applyProductEvent(once.copy, event);
    expect(twice.applied).toBe(false);
    expect(twice.copy).toEqual(once.copy);
  });

  it('S26 AS-17: a stale deletion (older version than the copy) is ignored', () => {
    const r = applyProductEvent(copy({ productVersion: 8 }), {
      kind: 'deleted',
      productId: 'p1',
      shopId: 's1',
      productVersion: 6,
    });
    expect(r.applied).toBe(false);
    expect(r.copy?.status).toBe('ACTIVE');
  });
});
