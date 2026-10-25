import { execFileSync } from 'node:child_process';

/**
 * Rows for the orders specs that must exist in bulk or in a shape the checkout cannot make (same-second slices, a NULL title,
 * a slice with no shop, a BisOrder with a different status). Written straight into the dev stack's Postgres, only for shops
 * and buyers the test made itself. Nothing here is a way to test the page: the page and the API still read them.
 */
const CONTAINER = process.env.AIQA_DB_CONTAINER ?? 'payment_system_db';

export type SeedSlice = {
  /** ShopOrder.id; give it to control the tie order of equal timestamps. */
  id?: string;
  status?: 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED';
  /** BisOrder.status (default follows the slice: PENDING -> RESERVED, PAID -> PAID, CANCELLED -> CANCELLED, REFUNDED -> REFUNDED). */
  orderStatus?: string;
  cancelReason?: string | null;
  createdAt: string;
  subtotal?: number;
  currency?: string;
  /** number of lines of this shop (default 1); `nullTitle` leaves the title NULL, `nullLineTotal` leaves lineTotalMinor NULL. */
  lines?: number;
  nullTitle?: boolean;
  nullLineTotal?: boolean;
  /** ShopOrder.shopId NULL (the shop is gone). */
  noShop?: boolean;
};

const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
const DEFAULT_ORDER_STATUS = { PENDING: 'RESERVED', PAID: 'PAID', CANCELLED: 'CANCELLED', REFUNDED: 'REFUNDED' } as const;

export function runSql(sql: string): string {
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'marketplace', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8' });
}

/** Inserts the slices (one BisOrder + one ShopOrder + lines each) and returns their ids in the order given. */
export function seedSlices(shopId: string, buyerId: string, slices: SeedSlice[]): { shopOrderId: string; orderId: string }[] {
  const out: { shopOrderId: string; orderId: string }[] = [];
  const statements: string[] = [];
  for (const slice of slices) {
    const shopOrderId = slice.id ?? crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const status = slice.status ?? 'PENDING';
    const subtotal = slice.subtotal ?? 1000;
    out.push({ shopOrderId, orderId });
    statements.push(
      `insert into "BisOrder"(id,"userId","createdAt","updatedAt",status,total,currency,"cancelReason") values (${q(orderId)},${q(buyerId)},${q(slice.createdAt)},${q(slice.createdAt)},${q(slice.orderStatus ?? DEFAULT_ORDER_STATUS[status])},${subtotal},${q(slice.currency ?? 'EUR')},${slice.cancelReason ? q(slice.cancelReason) : 'null'})`,
      `insert into "ShopOrder"(id,"bisOrderId","shopId",subtotal,status,"createdAt","updatedAt") values (${q(shopOrderId)},${q(orderId)},${slice.noShop ? 'null' : q(shopId)},${subtotal},${q(status)},${q(slice.createdAt)},${q(slice.createdAt)})`,
    );
    const lines = slice.lines ?? 1;
    for (let line = 0; line < lines; line += 1) {
      const each = Math.floor(subtotal / lines);
      statements.push(
        `insert into "BisOrderItem"(id,"bisOrderId","productId",quantity,"priceAtPurchase","createdAt","updatedAt","shopId",title,"discountMinor","lineTotalMinor") values (${q(crypto.randomUUID())},${q(orderId)},${q(crypto.randomUUID())},1,${each},${q(slice.createdAt)},${q(slice.createdAt)},${q(shopId)},${slice.nullTitle ? 'null' : q(`Seeded line ${line + 1}`)},0,${slice.nullLineTotal ? 'null' : each})`,
      );
    }
  }
  runSql(statements.join(';\n'));
  return out;
}
