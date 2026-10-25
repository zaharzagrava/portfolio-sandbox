import { expect, type Page } from '@playwright/test';
import { sql } from './support';

/** Set-up shared by the AI QA specs of the inventory writes (edit, stock, archive, restore): rows read back from the real database. */

export const menuButton = (page: Page, title: string) => page.getByRole('button', { name: `Actions for ${title}`, exact: true });

export async function openRowAction(page: Page, title: string, item: string) {
  await menuButton(page, title).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** The product row as the database holds it. */
export async function productRow(id: string) {
  const row = (await sql<{ title: string; brand: string; category: string; description: string; priceMinor: number; price: unknown; quantity: number; version: number; status: string; currency: string; tags: unknown }>(
    `SELECT title, brand, category, description, "priceMinor", price, quantity, version, status, currency, tags FROM "Product" WHERE id = $1`,
    [id],
  ))[0];
  expect(row, `product ${id} exists`).toBeTruthy();
  return row;
}

export type OutboxRow = { topic: string; eventName: string; aggregateVersion: number; changedFields: string[] | null; status: unknown; quantity: number | null };

/** Every outbox row of a product, oldest first. */
export async function outboxOf(id: string): Promise<OutboxRow[]> {
  return sql<OutboxRow>(
    `SELECT topic, "eventName", (payload->>'aggregateVersion')::int AS "aggregateVersion", payload->'payload'->'changedFields' AS "changedFields",
            payload->'payload'->>'status' AS status, (payload->'payload'->>'quantity')::int AS quantity
       FROM "Outbox" WHERE "aggregateId" = $1 AND "aggregateType" = 'products' ORDER BY "createdAt", id`,
    [id],
  );
}

export const historyOf = (id: string) =>
  sql<{ fromStatus: string; toStatus: string; productVersion: number; actorId: string | null }>(
    `SELECT "fromStatus", "toStatus", "productVersion", "actorId" FROM "ProductStatusHistory" WHERE "productId" = $1 ORDER BY at, id`,
    [id],
  );

export const indexRow = async (id: string) =>
  (await sql<{ title: string; status: string; quantity: number; priceMinor: number }>(`SELECT title, status, quantity, "priceMinor" FROM "SearchShopProduct" WHERE "productId" = $1`, [id]))[0];
