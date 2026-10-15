import { orderPaid, payoutPaid, type OrderPaidInput } from './events';

/**
 * The golden dataset of S16 AS-71 (FR-045): three shops (`x`, `y`, `z`), twelve March 2026 lines over two rate regimes
 * (the default 10% and a 5% rate for shop y's toys from 2026-03-11), one retroactive rate change after the close
 * (shop x, electronics, 800 bps from 2026-03-01), one late sale (shop y) and one late payout (shop z). The expected
 * output is checked in as `golden.expected.json`, worked out by hand from FR-011 (half up, per line), not by the code.
 */
export type GoldenShop = 'x' | 'y' | 'z';

interface Line {
  shop: GoldenShop;
  lineId: string;
  category: string;
  priceMinor: number;
  paidAt: string;
}

const LINES: Line[] = [
  {
    shop: 'x',
    lineId: 'g-01',
    category: 'electronics',
    priceMinor: 12000,
    paidAt: '2026-03-05T10:00:00Z',
  },
  {
    shop: 'x',
    lineId: 'g-02',
    category: 'electronics',
    priceMinor: 8500,
    paidAt: '2026-03-18T10:00:00Z',
  },
  {
    shop: 'x',
    lineId: 'g-03',
    category: 'books',
    priceMinor: 1999,
    paidAt: '2026-03-20T10:00:00Z',
  },
  {
    shop: 'x',
    lineId: 'g-04',
    category: 'books',
    priceMinor: 3001,
    paidAt: '2026-03-31T23:00:00Z',
  },
  {
    shop: 'y',
    lineId: 'g-05',
    category: 'electronics',
    priceMinor: 5005,
    paidAt: '2026-03-02T10:00:00Z',
  },
  {
    shop: 'y',
    lineId: 'g-06',
    category: 'toys',
    priceMinor: 700,
    paidAt: '2026-03-10T10:00:00Z',
  },
  {
    shop: 'y',
    lineId: 'g-07',
    category: 'toys',
    priceMinor: 1250,
    paidAt: '2026-03-12T10:00:00Z',
  },
  {
    shop: 'y',
    lineId: 'g-08',
    category: 'electronics',
    priceMinor: 45000,
    paidAt: '2026-03-29T10:00:00Z',
  },
  {
    shop: 'z',
    lineId: 'g-09',
    category: 'books',
    priceMinor: 333,
    paidAt: '2026-03-03T10:00:00Z',
  },
  {
    shop: 'z',
    lineId: 'g-10',
    category: 'books',
    priceMinor: 666,
    paidAt: '2026-03-22T10:00:00Z',
  },
  {
    shop: 'z',
    lineId: 'g-11',
    category: 'electronics',
    priceMinor: 9999,
    paidAt: '2026-03-25T10:00:00Z',
  },
  {
    shop: 'z',
    lineId: 'g-12',
    category: 'toys',
    priceMinor: 100,
    paidAt: '2026-03-30T10:00:00Z',
  },
];

const orderId = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const GOLDEN = {
  closeAt: '2026-04-02T02:00:00Z',
  ratesAt: '2026-03-01T08:00:00Z',
  changeAt: '2026-04-05T09:00:00Z',
  lateSaleAt: '2026-04-03T10:00:00Z',
  latePayoutAt: '2026-04-04T10:00:00Z',
  lateOrderId: orderId(99),
  /** Shop y's toys are 5% from the 11th. */
  toysRate: {
    category: 'toys',
    rateBps: 500,
    validFrom: '2026-03-11T00:00:00Z',
    reason: 'toys-promo',
  },
  /** The retroactive change after the close. */
  retroChange: {
    category: 'electronics',
    rateBps: 800,
    validFrom: '2026-03-01T00:00:00Z',
    reason: 'golden-retro',
  },
  latePayoutMinor: 6000,
} as const;

/** One `order.paid` per line, delivered before the close. */
export const goldenOrders = (shops: Record<GoldenShop, string>) =>
  LINES.map((line, i): OrderPaidInput => ({
    orderId: orderId(i + 1),
    paidAt: line.paidAt,
    lines: [
      {
        lineId: line.lineId,
        shopId: shops[line.shop],
        category: line.category,
        unitPriceMinor: line.priceMinor,
      },
    ],
  }));

export const goldenMessages = (shops: Record<GoldenShop, string>) =>
  goldenOrders(shops).map((order) => orderPaid(order));

/** The late sale of shop y: electronics 2500 paid 2026-03-31T22:00:00Z, applied after the close. */
export const goldenLateSale = (shops: Record<GoldenShop, string>) =>
  orderPaid({
    orderId: GOLDEN.lateOrderId,
    paidAt: '2026-03-31T22:00:00Z',
    lines: [
      {
        lineId: 'g-13',
        shopId: shops.y,
        category: 'electronics',
        unitPriceMinor: 2500,
      },
    ],
  });

export const goldenLatePayout = (shops: Record<GoldenShop, string>) =>
  payoutPaid({
    payoutId: '40000000-0000-4000-8000-000000000001',
    shopId: shops.z,
    amountMinor: GOLDEN.latePayoutMinor,
    paidAt: '2026-03-28T10:00:00Z',
  });
