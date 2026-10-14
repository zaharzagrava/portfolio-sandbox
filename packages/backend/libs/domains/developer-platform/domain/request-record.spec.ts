import { costOf, recordEventId } from './request-record';

describe('S42 request record rules (FR-054, FR-058, AS-58, AS-64)', () => {
  it('a plain call costs 1', () => {
    expect(costOf('GET', '/v1/products', undefined, false)).toEqual({
      cost: 1,
    });
    expect(costOf('PATCH', '/v1/products/:id', { title: 'x' }, false)).toEqual({
      cost: 1,
    });
  });

  it('a batch costs its operations and reports them', () => {
    const body = { operations: [{}, {}, {}, {}, {}] };
    expect(costOf('POST', '/v1/batch', body, false)).toEqual({
      cost: 5,
      batchOps: 5,
    });
  });

  it('bulk stock costs one unit per 100 items, at least one', () => {
    const items = (n: number) => ({
      items: Array.from({ length: n }, () => ({})),
    });
    expect(costOf('POST', '/v1/stock/bulk', items(1), false).cost).toBe(1);
    expect(costOf('POST', '/v1/stock/bulk', items(100), false).cost).toBe(1);
    expect(costOf('POST', '/v1/stock/bulk', items(101), false).cost).toBe(2);
    expect(costOf('POST', '/v1/stock/bulk', items(10_000), false).cost).toBe(
      100,
    );
  });

  it('a replay counts as the one request it replays', () => {
    expect(
      costOf('POST', '/v1/batch', { operations: [{}, {}, {}] }, true),
    ).toEqual({ cost: 1, batchOps: 3 });
    expect(
      costOf('POST', '/v1/stock/bulk', { items: new Array(500).fill({}) }, true)
        .cost,
    ).toBe(1);
  });

  it('a malformed body costs 1', () => {
    expect(costOf('POST', '/v1/batch', 'nonsense', false)).toEqual({ cost: 1 });
    expect(costOf('POST', '/v1/batch', { operations: 'x' }, false)).toEqual({
      cost: 1,
    });
  });

  it('the event id is UUID-shaped, derived from the request id, and differs per request', () => {
    const a = recordEventId('req_aaaa');
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(recordEventId('req_aaaa')).toBe(a);
    expect(recordEventId('req_bbbb')).not.toBe(a);
  });
});
