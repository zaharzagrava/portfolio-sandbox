import {
  pickupClustersResponseSchema,
  pickupNearSearchResponseSchema,
  pickupPointsNearResponseSchema,
} from '@marketplace-sandbox/contracts';
import type {
  PickupNearItem,
  PickupPointNear,
} from '@marketplace-sandbox/contracts';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

// Typed with the contract types so a renamed or retyped shared field fails compilation.
const point: Omit<PickupPointNear, 'openingHours'> = {
  id: '0b5f6f0e-1111-4222-8333-444455556666',
  shopId: '1c5f6f0e-1111-4222-8333-444455556666',
  name: 'Corner kiosk',
  address: '1 Main St',
  lat: 52.52,
  lng: 13.4,
  distanceM: 420,
};
const nearby: PickupNearItem = {
  productId: '2d5f6f0e-1111-4222-8333-444455556666',
  title: 'AirPods',
  priceMinor: 12900,
  currency: 'EUR',
  nearest: { pickupPointId: point.id, distanceM: 420, quantity: 3 },
};

describe('W02 B-7: pickup contracts', () => {
  it('W02 B-7: /pickup-points/near parses a page built from the real point view plus the S19 fields', () => {
    const body = {
      items: [
        {
          ...point,
          openingHours: {
            timezone: 'Europe/Berlin',
            weekly: { mon: [{ open: '09:00', close: '18:00' }] },
          },
          quantity: 3,
        },
        { ...point, id: 'x', openingHours: {} },
      ],
      nextCursor: null,
    };
    expect(ok(pickupPointsNearResponseSchema, body)).toBe(true);
  });

  it('W02 B-7: /pickup-points/near rejects a point without openingHours, a bad latitude, bad hours and a bare array', () => {
    const good = { ...point, openingHours: {} };
    const page = (items: unknown[]) => ({ items, nextCursor: null });
    expect(ok(pickupPointsNearResponseSchema, page([good]))).toBe(true);
    const { openingHours: _o, ...noHours } = good;
    expect(ok(pickupPointsNearResponseSchema, page([noHours]))).toBe(false);
    expect(
      ok(pickupPointsNearResponseSchema, page([{ ...good, lat: 91 }])),
    ).toBe(false);
    expect(ok(pickupPointsNearResponseSchema, [good])).toBe(false);
    expect(
      ok(
        pickupPointsNearResponseSchema,
        page([
          {
            ...good,
            openingHours: {
              timezone: 'UTC',
              weekly: { mon: [{ open: '9am', close: '5pm' }] },
            },
          },
        ]),
      ),
    ).toBe(false);
  });

  it('W02 B-7: /search/near parses hits built from the real nearest-product view', () => {
    const item = {
      productId: nearby.productId,
      title: nearby.title,
      priceMinor: nearby.priceMinor,
      currency: nearby.currency,
      nearest: { ...nearby.nearest, name: 'Corner kiosk' },
    };
    const body = { items: [item], nextCursor: 'abc' };
    expect(ok(pickupNearSearchResponseSchema, body)).toBe(true);
    expect(
      ok(pickupNearSearchResponseSchema, {
        ...body,
        items: [{ ...item, priceMinor: 12.5 }],
      }),
    ).toBe(false);
    expect(
      ok(pickupNearSearchResponseSchema, {
        ...body,
        items: [{ ...item, nearest: undefined }],
      }),
    ).toBe(false);
  });

  it('W02 B-7: /pickup-points/clusters parses cells and rejects a missing truncated flag', () => {
    const cells = [
      {
        cellId: '12/2200/1343',
        offers: 7,
        pickupPoints: 2,
        lat: 52.5,
        lng: 13.4,
      },
      {
        cellId: '12/2201/1343',
        offers: 1,
        pickupPoints: 1,
        lat: 52.5,
        lng: 13.5,
        pickupPointId: point.id,
      },
    ];
    expect(ok(pickupClustersResponseSchema, { cells, truncated: false })).toBe(
      true,
    );
    expect(ok(pickupClustersResponseSchema, { cells })).toBe(false);
    expect(
      ok(pickupClustersResponseSchema, {
        cells: [{ ...cells[0], offers: -1 }],
        truncated: false,
      }),
    ).toBe(false);
  });
});
