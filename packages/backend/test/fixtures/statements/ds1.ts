import { ledgerJournal, orderPaid, type OrderPaidInput } from './events';

/**
 * Dataset DS-1 of the S16 spec: shop `a`, March 2026 (`o1/l1` electronics 10000, `o2/l2` electronics 20000, `o3/l3`
 * books 500, all paid `2026-03-15T12:00:00Z`) and shop `b` (`o5/l5` electronics 4005 paid `2026-03-20T09:00:00Z`).
 * At the default 10%: shop a gross 30500, commission 3050, net 27450, 3 lines; shop b 4005 / 401 / 3604 / 1.
 * `l4` is the late March sale of AS-19 (books 1000 paid `2026-03-31T23:58:00Z`).
 */
export const DS1 = {
  o1: '10000000-0000-4000-8000-000000000001',
  o2: '10000000-0000-4000-8000-000000000002',
  o3: '10000000-0000-4000-8000-000000000003',
  o4: '10000000-0000-4000-8000-000000000004',
  o5: '10000000-0000-4000-8000-000000000005',
  l1: '20000000-0000-4000-8000-000000000001',
  l2: '20000000-0000-4000-8000-000000000002',
  l3: '20000000-0000-4000-8000-000000000003',
  l4: '20000000-0000-4000-8000-000000000004',
  l5: '20000000-0000-4000-8000-000000000005',
  paidA: '2026-03-15T12:00:00Z',
  paidB: '2026-03-20T09:00:00Z',
  paidL4: '2026-03-31T23:58:00Z',
} as const;

export function ds1Orders(shops: { a: string; b: string }): OrderPaidInput[] {
  return [
    {
      orderId: DS1.o1,
      paidAt: DS1.paidA,
      lines: [
        {
          lineId: DS1.l1,
          shopId: shops.a,
          category: 'electronics',
          unitPriceMinor: 10000,
        },
      ],
    },
    {
      orderId: DS1.o2,
      paidAt: DS1.paidA,
      lines: [
        {
          lineId: DS1.l2,
          shopId: shops.a,
          category: 'electronics',
          unitPriceMinor: 20000,
        },
      ],
    },
    {
      orderId: DS1.o3,
      paidAt: DS1.paidA,
      lines: [
        {
          lineId: DS1.l3,
          shopId: shops.a,
          category: 'books',
          unitPriceMinor: 500,
        },
      ],
    },
    {
      orderId: DS1.o5,
      paidAt: DS1.paidB,
      lines: [
        {
          lineId: DS1.l5,
          shopId: shops.b,
          category: 'electronics',
          unitPriceMinor: 4005,
        },
      ],
    },
  ];
}

/** The messages of DS-1, ready for the sales consumer. */
export const ds1Messages = (shops: { a: string; b: string }) =>
  ds1Orders(shops).map((order) => orderPaid(order));

/**
 * The ledger's `SALE` journals for DS-1: per order the buyer's payment is cleared, the shop is credited its net and the
 * platform its fee. Shop a: net 9000 + 18000 + 450 = 27450, shop b: 3604, fees 1000 + 2000 + 50 + 401 = 3451.
 */
export const ds1Journals = (shops: { a: string; b: string }) => {
  const sale = (orderId: string, shopId: string, total: number, fee: number) =>
    ledgerJournal({
      orderId,
      postedAt: '2026-03-20T12:00:00Z',
      lines: [
        ['PAYMENTS_CLEARING', -total],
        [`SHOP_${shopId}`, total - fee],
        ['PLATFORM_FEES', fee],
      ],
    });
  return [
    sale(DS1.o1, shops.a, 10000, 1000),
    sale(DS1.o2, shops.a, 20000, 2000),
    sale(DS1.o3, shops.a, 500, 50),
    sale(DS1.o5, shops.b, 4005, 401),
  ];
};

/** The late sale `l4` (AS-19, AS-45): it occurred in March and is delivered after the close. */
export const lateSaleL4 = (shopId: string) =>
  orderPaid({
    orderId: DS1.o4,
    paidAt: DS1.paidL4,
    lines: [
      { lineId: DS1.l4, shopId, category: 'books', unitPriceMinor: 1000 },
    ],
  });
