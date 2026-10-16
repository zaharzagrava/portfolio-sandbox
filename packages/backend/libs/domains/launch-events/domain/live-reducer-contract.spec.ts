import {
  initialLiveState,
  reduceLive,
  type LiveClientEvent,
} from '@marketplace-sandbox/contracts';

const pin = (version: number) => ({
  version,
  productId: '00000000-0000-7000-8000-00000000bbbb',
  productTitle: 'Phone',
  text: `v${version}`,
  pinnedAt: '2026-10-05T10:00:00.000Z',
});
const apply = (events: LiveClientEvent[]) =>
  events.reduce(reduceLive, initialLiveState());

// The reducer lives in packages/contracts (full property tests in live-reducer.spec.ts there); this spec
// proves from the backend side that the exported reducer honours the ordering rules the server relies on.
describe('S23 live reducer ordering (contract consumed by the backend)', () => {
  it('S23 AS-09: stale pins are ignored and duplicated or reordered events reach the same state', () => {
    const a = apply([
      { type: 'pin', data: pin(3) },
      { type: 'pin', data: pin(2) },
      { type: 'pin', data: pin(3) },
    ]);
    const b = apply([
      { type: 'pin', data: pin(2) },
      { type: 'pin', data: pin(3) },
    ]);
    expect(a.pin?.version).toBe(3);
    expect(b.pin?.version).toBe(3);
    expect(a.pinVersion).toBe(b.pinVersion);
  });
});
