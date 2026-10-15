import {
  MASS_DELETE_MIN_MISSING,
  classifyReconciliation,
  confirmMissing,
  massDeleteGuard,
  type LocalLink,
  type RemoteItem,
} from './reconcile-classify';

const link = (id: string, over: Partial<LocalLink> = {}): LocalLink => ({
  externalId: id,
  contentDigest: `d-${id}`,
  syncedStock: 5,
  localQuantity: 5,
  ...over,
});
const remote = (id: string, over: Partial<RemoteItem> = {}): RemoteItem => ({
  externalId: id,
  digest: `d-${id}`,
  stock: 5,
  ...over,
});

describe('S08 reconciliation classification', () => {
  it('S08 AS-61: classifies matched, missing at provider, missing locally, content drift, stock drift', () => {
    const links = [
      link('m1'),
      link('m2'),
      link('m3'),
      link('gone'),
      link('c1', { contentDigest: 'old' }),
      link('s1', { syncedStock: 6, localQuantity: 4 }),
    ];
    const listing = [
      remote('m1'),
      remote('m2'),
      remote('m3'),
      remote('c1'),
      remote('s1', { stock: 6 }),
      remote('new'),
    ];
    const out = classifyReconciliation(links, listing);
    expect(out.counts).toEqual({
      linked: 6,
      remote: 6,
      matched: 3,
      missingAtProvider: 1,
      missingLocally: 1,
      contentDrift: 1,
      stockDrift: 1,
      autoFixed: 4,
      needsReview: 0,
    });
    const byId = Object.fromEntries(out.findings.map((f) => [f.externalId, f]));
    expect(byId.gone).toMatchObject({
      kind: 'missing_at_provider',
      needsReview: false,
    });
    expect(byId.new).toMatchObject({
      kind: 'missing_locally',
      needsReview: false,
    });
    expect(byId.c1).toMatchObject({
      kind: 'content_drift',
      needsReview: false,
    });
    expect(byId.s1).toMatchObject({ kind: 'stock_drift', needsReview: false });
    expect(byId.s1.merge).toMatchObject({
      action: 'push',
      pushValue: 4,
      localDelta: 0,
    });
    expect(out.findings).toHaveLength(4);
  });

  it('S08 AS-61: exactly one side differs from the base -> pull when only the provider moved', () => {
    const out = classifyReconciliation(
      [link('a', { syncedStock: 5, localQuantity: 5 })],
      [remote('a', { stock: 8 })],
    );
    expect(out.findings[0]).toMatchObject({
      kind: 'stock_drift',
      merge: { action: 'pull', localDelta: 3 },
    });
  });

  it('S08 AS-61/AS-37: both sides differ -> merged by the same rule; an unmergeable drift needs review', () => {
    const merged = classifyReconciliation(
      [link('a', { syncedStock: 10, localQuantity: 8 })],
      [remote('a', { stock: 7 })],
    );
    expect(merged.findings[0].merge).toMatchObject({
      action: 'merge',
      result: 5,
    });
    expect(merged.findings[0].needsReview).toBe(false);
    const conflict = classifyReconciliation(
      [link('a', { syncedStock: 3, localQuantity: 0 })],
      [remote('a', { stock: 1 })],
    );
    expect(conflict.findings[0]).toMatchObject({
      kind: 'stock_drift',
      needsReview: true,
    });
    expect(conflict.counts).toMatchObject({ autoFixed: 0, needsReview: 1 });
  });

  it('S08 AS-61: a link without a local quantity is not compared for stock', () => {
    const out = classifyReconciliation(
      [link('a', { localQuantity: undefined })],
      [remote('a', { stock: 99 })],
    );
    expect(out.counts.stockDrift).toBe(0);
    expect(out.counts.matched).toBe(1);
  });

  it('S08 AS-61: content and stock drift on one variant give two findings and no match', () => {
    const out = classifyReconciliation(
      [link('a', { contentDigest: 'old' })],
      [remote('a', { stock: 6 })],
    );
    expect(out.findings.map((f) => f.kind).sort()).toEqual([
      'content_drift',
      'stock_drift',
    ]);
    expect(out.counts.matched).toBe(0);
  });

  it('S08 AS-61: a clean store has no findings', () => {
    const out = classifyReconciliation([link('a')], [remote('a')]);
    expect(out.findings).toEqual([]);
    expect(out.abortMassDelete).toBe(false);
  });

  it('S08 AS-62: a direct read decides - gone confirms, present is list_inconsistent', () => {
    expect(confirmMissing('gone')).toBe('missing_at_provider');
    expect(confirmMissing('present')).toBe('list_inconsistent');
  });

  it.each([
    ['9 of 10 links missing (below the 10 minimum)', 10, 9, false],
    ['10 of 10 links missing', 10, 10, true],
    ['20 of 100 (exactly 20%)', 100, 20, false],
    ['21 of 100 (21%)', 100, 21, true],
    ['10 of 100 (10%)', 100, 10, false],
    ['97 of 100 (partial listing)', 100, 97, true],
    ['0 of 0', 0, 0, false],
    ['11 of 50 (22%)', 50, 11, true],
    ['10 of 50 (exactly 20%)', 50, 10, false],
  ])(
    'S08 AS-63: massDeleteGuard %s -> abort=%s',
    (_n, total, missing, abort) => {
      expect(massDeleteGuard(total, missing)).toBe(abort);
    },
  );

  it('S08 AS-63: classification flags abortMassDelete for a partial listing (3 of 100 returned)', () => {
    const links = Array.from({ length: 100 }, (_, i) => link(`l${i}`));
    const out = classifyReconciliation(links, [
      remote('l0'),
      remote('l1'),
      remote('l2'),
    ]);
    expect(out.abortMassDelete).toBe(true);
    expect(out.counts.missingAtProvider).toBe(97);
    expect(MASS_DELETE_MIN_MISSING).toBe(10);
  });
});
