import {
  decideStockLow,
  STOCK_LOW_THRESHOLD,
  StockLowInput,
  stockLowEventId,
} from './stock-low';

const snapshot = (over: Partial<StockLowInput> = {}): StockLowInput => ({
  productId: 'p1',
  shopId: 's1',
  title: 'Mug',
  quantity: 5,
  changedFields: ['quantity'],
  isSandbox: false,
  occurredAt: '2026-10-06T12:00:00.000Z',
  ...over,
});

describe('low-stock rule (pure)', () => {
  it('S43 AS-28: the threshold is 5', () => {
    expect(STOCK_LOW_THRESHOLD).toBe(5);
  });

  it.each<[string, Partial<StockLowInput>, boolean]>([
    ['quantity 5 with quantity changed', { quantity: 5 }, true],
    ['quantity 6', { quantity: 6 }, false],
    ['quantity 0', { quantity: 0 }, true],
    [
      'quantity 3 but only the title changed',
      { quantity: 3, changedFields: ['title'] },
      false,
    ],
    [
      'quantity 3, no changed fields',
      { quantity: 3, changedFields: [] },
      false,
    ],
    [
      'quantity 3, quantity among several changed fields',
      { quantity: 3, changedFields: ['title', 'quantity', 'tags'] },
      true,
    ],
    [
      'a sandbox snapshot at quantity 0',
      { quantity: 0, isSandbox: true },
      false,
    ],
    ['a negative quantity', { quantity: -1 }, true],
  ])('S43 AS-28: %s -> emit %s', (_name, over, emit) => {
    expect(decideStockLow(snapshot(over)).emit).toBe(emit);
  });

  it('S43 AS-28: an emitted event carries the product, title, stock and threshold', () => {
    expect(
      decideStockLow(snapshot({ quantity: 4, title: 'Blue mug' })),
    ).toMatchObject({
      emit: true,
      object: {
        id: 'p1',
        object: 'product',
        title: 'Blue mug',
        stock: 4,
        threshold: 5,
      },
      utcDay: '2026-10-06',
      resourceVersion: null,
    });
  });

  it('S43 AS-28: a second qualifying snapshot on the same UTC day gets the same event id (not re-delivered)', () => {
    const first = decideStockLow(
      snapshot({ occurredAt: '2026-10-06T00:00:00.000Z' }),
    );
    const second = decideStockLow(
      snapshot({ quantity: 2, occurredAt: '2026-10-06T23:59:59.999Z' }),
    );
    expect(first.emit && second.emit).toBe(true);
    expect((first as { eventId: string }).eventId).toBe(
      (second as { eventId: string }).eventId,
    );
  });

  it('S43 AS-28: the same product on the next UTC day emits again with another id', () => {
    const today = decideStockLow(
      snapshot({ occurredAt: '2026-10-06T23:59:59.999Z' }),
    );
    const tomorrow = decideStockLow(
      snapshot({ occurredAt: '2026-10-07T00:00:00.000Z' }),
    );
    expect((today as { utcDay: string }).utcDay).toBe('2026-10-06');
    expect((tomorrow as { utcDay: string }).utcDay).toBe('2026-10-07');
    expect((today as { eventId: string }).eventId).not.toBe(
      (tomorrow as { eventId: string }).eventId,
    );
  });

  it('S43 AS-28: the UTC day comes from occurredAt, whatever its offset', () => {
    // 2026-10-07T01:30+02:00 is 2026-10-06T23:30Z
    expect(
      decideStockLow(snapshot({ occurredAt: '2026-10-07T01:30:00.000+02:00' })),
    ).toMatchObject({ emit: true, utcDay: '2026-10-06' });
  });

  it('S43 AS-28: the event id is deterministic per product and day, and differs between products', () => {
    expect(stockLowEventId('p1', '2026-10-06')).toBe(
      stockLowEventId('p1', '2026-10-06'),
    );
    expect(stockLowEventId('p1', '2026-10-06')).not.toBe(
      stockLowEventId('p2', '2026-10-06'),
    );
    expect(stockLowEventId('p1', '2026-10-06')).toMatch(/^evt_[0-9a-f]{32}$/);
  });

  it('S43 AS-28: an occurredAt that is not a date never emits', () => {
    expect(decideStockLow(snapshot({ occurredAt: 'yesterday' })).emit).toBe(
      false,
    );
  });
});
