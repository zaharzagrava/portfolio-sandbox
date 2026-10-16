import {
  deliveryBuyerViewSchema,
  deliveryCourierViewSchema,
  deliveryShopViewSchema,
} from '@marketplace-sandbox/contracts';
import type { DeliveryHistoryRecord, DeliveryRecord } from './delivery-ports';
import {
  POSITION_STALE_AFTER_MS,
  toBuyerView,
  toCourierView,
  toShopView,
} from './delivery-views';

const NOW = 1_800_000_000_000;
const COURIER_ID = '0192c000-0000-7000-8000-00000000c001';
const BUYER_ID = '0192c000-0000-7000-8000-00000000b001';
const SHOP_ID = '0192c000-0000-7000-8000-00000000a001';

const row = (patch: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: '0192c000-0000-7000-8000-0000000000d1',
  shopId: SHOP_ID,
  orderId: '0192c000-0000-7000-8000-0000000000e1',
  buyerId: BUYER_ID,
  city: 'berlin',
  pickup: { lat: 52.52, lng: 13.405 },
  dropoff: { lat: 52.51, lng: 13.36 },
  status: 'ASSIGNED',
  courierId: COURIER_ID,
  attempt: 3,
  feeMinor: 499,
  currency: 'EUR',
  surge: 1,
  nextActionAt: new Date(NOW + 15_000),
  cancelReason: null,
  orderSyncedStatus: null,
  version: 7,
  createdAt: new Date(NOW - 60_000),
  updatedAt: new Date(NOW - 30_000),
  ...patch,
});

const history: DeliveryHistoryRecord[] = [
  {
    id: 'h1',
    deliveryId: 'd1',
    from: null,
    to: 'REQUESTED',
    actorKind: 'shop',
    actorId: SHOP_ID,
    detail: null,
    version: 1,
    at: new Date(NOW - 60_000),
  },
  {
    id: 'h2',
    deliveryId: 'd1',
    from: 'REQUESTED',
    to: 'OFFERED',
    actorKind: 'system',
    actorId: COURIER_ID,
    detail: 'internal note',
    version: 2,
    at: new Date(NOW - 59_000),
  },
];

const position = (ageMs: number) => ({
  lat: 52.52,
  lng: 13.4,
  ts: NOW - ageMs,
});

describe('delivery views', () => {
  describe('buyer view', () => {
    it('S20 AS-44: has exactly the allowed fields and parses with the contract', () => {
      const view = toBuyerView(
        row(),
        { vehicle: 'bike', position: position(5_000) },
        NOW,
      );
      expect(Object.keys(view).sort()).toEqual(
        [
          'courier',
          'createdAt',
          'currency',
          'dropoff',
          'feeMinor',
          'id',
          'orderId',
          'pickup',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(deliveryBuyerViewSchema.parse(view)).toEqual(view);
      expect(Object.keys(view.courier ?? {}).sort()).toEqual([
        'position',
        'vehicle',
      ]);
    });

    it('S20 AS-44: never carries the courier id, offer data, attempt or version', () => {
      const text = JSON.stringify(
        toBuyerView(row({ status: 'OFFERED' }), { vehicle: 'bike' }, NOW),
      );
      for (const secret of [
        COURIER_ID,
        'attempt',
        'version',
        'nextActionAt',
        'offer',
        'courierId',
        'orderSyncedStatus',
      ])
        expect(text).not.toContain(secret);
    });

    it.each(['ASSIGNED', 'PICKED_UP'] as const)(
      'S20 AS-44: shows the position in %s',
      (status) => {
        const view = toBuyerView(
          row({ status }),
          { vehicle: 'car', position: position(1_000) },
          NOW,
        );
        expect(view.courier?.position).toEqual({
          lat: 52.52,
          lng: 13.4,
          ts: NOW - 1_000,
          stale: false,
        });
      },
    );

    it.each(['REQUESTED', 'OFFERED', 'DELIVERED', 'CANCELLED'] as const)(
      'S20 AS-44: hides the position in %s',
      (status) => {
        const view = toBuyerView(
          row({
            status,
            courierId: status === 'DELIVERED' ? COURIER_ID : null,
          }),
          { vehicle: 'car', position: position(1_000) },
          NOW,
        );
        expect(view.courier?.position).toBeUndefined();
      },
    );

    it.each([
      ['exactly 60 s old', 60_000, false],
      ['60 001 ms old', 60_001, true],
      ['5 s old', 5_000, false],
    ])('S20 AS-44: a position %s has stale=%s', (_n, age, stale) => {
      const view = toBuyerView(
        row(),
        { vehicle: 'bike', position: position(age) },
        NOW,
      );
      expect(view.courier?.position?.stale).toBe(stale);
      expect(POSITION_STALE_AFTER_MS).toBe(60_000);
    });

    it('S20 AS-44: no courier block before a courier is assigned', () => {
      const view = toBuyerView(
        row({ status: 'OFFERED', courierId: null }),
        null,
        NOW,
      );
      expect(view.courier).toBeUndefined();
    });
  });

  describe('courier view', () => {
    it('S20 AS-44: has exactly the allowed fields, no buyer id, and parses with the contract', () => {
      const view = toCourierView(row(), null);
      expect(Object.keys(view).sort()).toEqual(
        ['currency', 'dropoff', 'feeMinor', 'id', 'pickup', 'status'].sort(),
      );
      expect(deliveryCourierViewSchema.parse(view)).toEqual(view);
      expect(JSON.stringify(view)).not.toContain(BUYER_ID);
    });

    it('S20 AS-44: shows the offer expiry to the courier holding the live offer', () => {
      const expiresAt = new Date(NOW + 10_000);
      const view = toCourierView(
        row({ status: 'OFFERED', courierId: null }),
        expiresAt,
      );
      expect(view.offerExpiresAt).toBe(expiresAt.toISOString());
      expect(deliveryCourierViewSchema.parse(view)).toEqual(view);
    });
  });

  describe('shop view', () => {
    it('S20 AS-45: has exactly the allowed fields, no courier id or coordinates, and parses with the contract', () => {
      const view = toShopView(row());
      expect(Object.keys(view).sort()).toEqual(
        [
          'city',
          'createdAt',
          'currency',
          'dropoff',
          'feeMinor',
          'id',
          'orderId',
          'pickup',
          'status',
          'surge',
        ].sort(),
      );
      expect(deliveryShopViewSchema.parse(view)).toEqual(view);
      const text = JSON.stringify(view);
      for (const secret of [
        COURIER_ID,
        BUYER_ID,
        'courierId',
        'courier',
        'attempt',
        'version',
      ])
        expect(text).not.toContain(secret);
    });

    it('S20 AS-45: the detail adds the history without actor ids', () => {
      const view = toShopView(row(), history);
      expect(view.history).toEqual([
        {
          from: null,
          to: 'REQUESTED',
          at: new Date(NOW - 60_000).toISOString(),
          actorKind: 'shop',
        },
        {
          from: 'REQUESTED',
          to: 'OFFERED',
          at: new Date(NOW - 59_000).toISOString(),
          actorKind: 'system',
          detail: 'internal note',
        },
      ]);
      expect(JSON.stringify(view)).not.toContain(COURIER_ID);
      expect(deliveryShopViewSchema.parse(view)).toEqual(view);
    });
  });
});
