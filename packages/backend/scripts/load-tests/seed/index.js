#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

/**
 * Load-test seeder. Run from packages/backend (reads .env):
 *
 *   node scripts/load-tests/seed/index.js payment      [--users=100000]
 *   node scripts/load-tests/seed/index.js search       [--users=100000] [--sellers=1000] [--products=50000]
 *   node scripts/load-tests/seed/index.js seller-stats [--users=100000] [--sellers=5000] [--products-per-seller=10] [--sales-per-seller=500]
 *   node scripts/load-tests/seed/index.js chat         [--users=100000] [--channels=100]
 *   node scripts/load-tests/seed/index.js notifications [--users=100000]
 *   node scripts/load-tests/seed/index.js clean <flow>
 *
 * Each flow first deletes whatever its previous run created (accounts are
 * namespaced by email: lt-<flow>-<role>-<n>@loadtest.local), then writes
 * scripts/load-tests/data/<flow>.json for the matching k6 script.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  BACKEND_ROOT,
  LOADTEST_PASSWORD,
  log,
  createPool,
  hashPassword,
  seedUsers,
  cleanFlow,
  writeData,
  randomInt,
  pick,
  chunk,
} = require('./common');
const {
  CATEGORY_NAMES,
  ALL_BRANDS,
  generateProduct,
  generateQueries,
  insertProducts,
  indexProducts,
  deleteIndexedLoadtestProducts,
} = require('./catalog');

const FLOWS = ['payment', 'search', 'seller-stats', 'chat', 'notifications'];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (const arg of rest) {
    const match = /^--([\w-]+)=(.+)$/.exec(arg);
    if (match) flags[match[1]] = Number.isNaN(Number(match[2])) ? match[2] : Number(match[2]);
    else positional.push(arg);
  }
  return { command, positional, flags };
}

// --- --- --- --- --- Flows --- --- --- --- --- //

async function seedPayment(pool, flags) {
  const userCount = flags.users ?? 100_000;
  const passwordHash = await hashPassword();

  const users = await seedUsers(pool, { flow: 'payment', role: 'USER', count: userCount, passwordHash });

  // One open BisOrder per buyer - the edge validates bisOrderId as a UUIDv7,
  // which the DB default uuidv7() guarantees.
  const bisOrderByUser = new Map();
  for (const batch of chunk(users, 10_000)) {
    const { rows } = await pool.query(
      `INSERT INTO "BisOrder" ("userId", "createdAt", "updatedAt")
       SELECT u, NOW(), NOW() FROM unnest($1::uuid[]) AS u
       RETURNING id, "userId"`,
      [batch.map((u) => u.userId)],
    );
    for (const row of rows) bisOrderByUser.set(row.userId, row.id);
    log(`  bis orders: ${bisOrderByUser.size}/${users.length}`);
  }

  writeData('payment.json', {
    password: LOADTEST_PASSWORD,
    users: users.map((u) => ({ email: u.email, bisOrderId: bisOrderByUser.get(u.userId) })),
  });
}

async function seedSearch(pool, flags) {
  const userCount = flags.users ?? 100_000;
  const sellerCount = flags.sellers ?? 1_000;
  const productCount = flags.products ?? 50_000;
  const passwordHash = await hashPassword();

  const esClient = createEsClient();
  await deleteIndexedLoadtestProducts(esClient);

  const users = await seedUsers(pool, { flow: 'search', role: 'USER', count: userCount, passwordHash });
  const sellers = await seedUsers(pool, { flow: 'search', role: 'SELLER', count: sellerCount, passwordHash });

  const products = Array.from({ length: productCount }, () => generateProduct(pick(sellers).userId));
  await insertProducts(pool, products);
  await indexProducts(esClient, products);

  writeData('search.json', {
    password: LOADTEST_PASSWORD,
    users: users.map((u) => u.email),
    queries: generateQueries(),
    categories: CATEGORY_NAMES,
    brands: ALL_BRANDS,
  });

  // SD-34 product-detail.test.js: ids in insertion order = popularity rank for the Zipf sampler.
  writeData('catalog.json', { productIds: products.slice(0, 10_000).map((p) => p.id) });
}

async function seedSellerStats(pool, flags) {
  const userCount = flags.users ?? 100_000;
  const sellerCount = flags.sellers ?? 5_000;
  const productsPerSeller = flags['products-per-seller'] ?? 10;
  const salesPerSeller = flags['sales-per-seller'] ?? 500;
  const passwordHash = await hashPassword();

  const chClient = createClickHouseClient();
  await applyClickHouseSchema(chClient);
  // Facts of a previous run belong to shops named `lt-seller-stats-*`; clean them before their shops go (cleanFlow).
  await deleteLoadtestFacts(pool, chClient);

  const buyers = await seedUsers(pool, { flow: 'seller-stats', role: 'USER', count: userCount, passwordHash });
  const sellers = await seedUsers(pool, { flow: 'seller-stats', role: 'SELLER', count: sellerCount, passwordHash });
  // S40: stats belong to a shop and are read by its members, so every seller gets a shop they own.
  const shops = await seedShops(pool, sellers);

  const productsBySeller = new Map();
  const products = [];
  for (const seller of sellers) {
    const own = Array.from({ length: productsPerSeller }, () => generateProduct(seller.userId));
    productsBySeller.set(seller.userId, own);
    products.push(...own);
  }
  await insertProducts(pool, products);

  // Sales history spread over the last 120 days so every ?days= window
  // (7/30/90) has data. Generated and flushed in chunks to bound memory.
  const now = Date.now();
  const DAY_MS = 86_400_000;
  const totalRows = sellers.length * salesPerSeller;
  let buffer = [];
  const refunds = [];
  let inserted = 0;

  const flush = async () => {
    if (!buffer.length) return;
    await chClient.insert({ table: 'shop_sale_facts', values: buffer, format: 'JSONEachRow' });
    inserted += buffer.length;
    buffer = [];
    log(`  sales (clickhouse): ${inserted}/${totalRows}`);
  };

  for (const seller of sellers) {
    const own = productsBySeller.get(seller.userId);
    for (let i = 0; i < salesPerSeller; i++) {
      const product = pick(own);
      const quantity = randomInt(1, 3);
      const orderId = crypto.randomUUID();
      buffer.push({
        shop_id: shops.get(seller.userId),
        order_id: orderId,
        product_id: product.id,
        title: product.title,
        buyer_id: pick(buyers).userId,
        units: quantity,
        line_total_minor: product.price * quantity,
        paid_at: new Date(now - Math.random() * 120 * DAY_MS).toISOString().replace('T', ' ').replace('Z', ''),
      });
      // ~6% of the orders are fully refunded, on the day they were paid
      if (Math.random() < 0.06)
        refunds.push({
          shop_id: shops.get(seller.userId),
          order_id: orderId,
          amount_minor: product.price * quantity,
          refunded_at: buffer[buffer.length - 1].paid_at,
        });
      if (buffer.length >= 200_000) await flush();
    }
  }
  await flush();
  if (refunds.length) await chClient.insert({ table: 'shop_refund_facts', values: refunds, format: 'JSONEachRow' });
  await chClient.close();

  writeData('seller-stats.json', {
    password: LOADTEST_PASSWORD,
    sellers: sellers.map((s) => ({ email: s.email, shopId: shops.get(s.userId) })),
  });
}

/** One ACTIVE shop per seller, owned by that seller (rows are written like the tenancy fixtures do; RLS bypassed for the seed). */
async function seedShops(pool, sellers) {
  const shops = new Map();
  for (const [index, batch] of chunk(sellers, 2_000).entries()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
      const { rows } = await client.query(
        `INSERT INTO "Shop" ("name", "slug", "plan", "status", "createdAt", "updatedAt")
         SELECT 'Load test shop ' || n, 'lt-seller-stats-' || n, 'STARTER', 'ACTIVE', now(), now()
         FROM generate_series($1::int, $2::int) AS n
         RETURNING id, slug`,
        [index * 2_000 + 1, index * 2_000 + batch.length],
      );
      const bySlug = new Map(rows.map((r) => [r.slug, r.id]));
      const ids = batch.map((_, i) => bySlug.get(`lt-seller-stats-${index * 2_000 + i + 1}`));
      await client.query(
        `INSERT INTO "ShopDirectory" ("shopId", "cell", "region", "version", "updatedAt")
         SELECT s, 'pooled', 'eu-central-1', 1, now() FROM unnest($1::uuid[]) AS s`,
        [ids],
      );
      await client.query(
        `INSERT INTO "ShopMembership" ("shopId", "userId", "role", "source", "createdAt")
         SELECT s, u, 'OWNER', 'owner', now() FROM unnest($1::uuid[], $2::uuid[]) AS t(s, u)`,
        [ids, batch.map((s) => s.userId)],
      );
      await client.query('COMMIT');
      batch.forEach((seller, i) => shops.set(seller.userId, ids[i]));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return shops;
}

/** Removes the facts, memberships and shops of earlier `seller-stats` runs (shops are named `lt-seller-stats-*`). */
async function deleteLoadtestFacts(pool, chClient) {
  const { rows } = await pool.query(`SELECT id FROM "Shop" WHERE slug LIKE 'lt-seller-stats-%'`);
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  for (const table of ['shop_sale_facts', 'shop_refund_facts'])
    await chClient.command({
      query: `ALTER TABLE ${table} DELETE WHERE shop_id IN ({ids:Array(String)})`,
      query_params: { ids },
      clickhouse_settings: { mutations_sync: '2' },
    });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
    await client.query(`DELETE FROM "ShopMembership" WHERE "shopId" = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM "ShopDirectory" WHERE "shopId" = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM "Shop" WHERE id = ANY($1::uuid[])`, [ids]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedChat(pool, flags) {
  const userCount = flags.users ?? 100_000;
  const channelCount = flags.channels ?? 100;
  const passwordHash = await hashPassword();

  const users = await seedUsers(pool, { flow: 'chat', role: 'USER', count: userCount, passwordHash });
  // One seller per channel so channels really are "from different sellers".
  const sellers = await seedUsers(pool, { flow: 'chat', role: 'SELLER', count: channelCount, passwordHash });

  const products = sellers.map((s) => generateProduct(s.userId));
  await insertProducts(pool, products);

  const channels = products.map((p) => ({
    id: crypto.randomUUID(),
    productId: p.id,
    sellerId: p.sellerId,
    title: p.title,
  }));

  // Mirrors ChatService#createChannel: channel + OWNER membership. Buyers
  // join lazily - the Rust gateway auto-adds a MEMBER on first subscribe.
  await pool.query(
    `INSERT INTO "ChatChannel" (id, "productId", "sellerId", title, "isArchived", "createdAt", "updatedAt")
     SELECT id, "productId", "sellerId", title, false, NOW(), NOW()
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[]) AS t(id, "productId", "sellerId", title)`,
    [channels.map((c) => c.id), channels.map((c) => c.productId), channels.map((c) => c.sellerId), channels.map((c) => c.title)],
  );
  await pool.query(
    `INSERT INTO "ChatChannelMember" (id, "channelId", "userId", role, status, "createdAt", "updatedAt")
     SELECT gen_random_uuid(), "channelId", "userId", 'OWNER', 'ACTIVE', NOW(), NOW()
     FROM unnest($1::uuid[], $2::uuid[]) AS t("channelId", "userId")`,
    [channels.map((c) => c.id), channels.map((c) => c.sellerId)],
  );
  log(`  chat channels: ${channels.length}`);

  writeData('chat.json', {
    password: LOADTEST_PASSWORD,
    users: users.map((u) => u.email),
    channels: channels.map((c) => c.id),
  });
}

/** Accounts only: the inbox items come from the burst script's events (or from a previous burst run). */
async function seedNotifications(pool, flags) {
  const userCount = flags.users ?? 100_000;
  const passwordHash = await hashPassword();
  const users = await seedUsers(pool, { flow: 'notifications', role: 'USER', count: userCount, passwordHash });
  writeData('notifications.json', {
    password: LOADTEST_PASSWORD,
    users: users.map((u) => ({ id: u.userId, email: u.email })),
  });
}

// --- --- --- --- --- Infra clients --- --- --- --- --- //

function createEsClient() {
  const { Client } = require('@elastic/elasticsearch');
  return new Client({ node: process.env.ELASTICSEARCH_NODE });
}

function createClickHouseClient() {
  const { createClient } = require('@clickhouse/client');
  return createClient({
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DATABASE,
  });
}

async function applyClickHouseSchema(chClient) {
  const ddl = fs.readFileSync(path.join(BACKEND_ROOT, 'clickhouse/051_shop_sale_facts.sql'), 'utf8');
  const statements = ddl
    .replace(/--.*$/gm, '')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const query of statements) await chClient.command({ query });
}

// --- --- --- --- --- Main --- --- --- --- --- //

const SEEDERS = {
  payment: seedPayment,
  search: seedSearch,
  'seller-stats': seedSellerStats,
  chat: seedChat,
  notifications: seedNotifications,
};

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const flow = command === 'clean' ? positional[0] : command;

  if (!FLOWS.includes(flow)) {
    console.error(`Usage: seed <${FLOWS.join('|')}> [--flags] | seed clean <flow>`);
    process.exit(1);
  }

  const pool = createPool();
  const startedAt = Date.now();

  try {
    await cleanFlow(pool, flow);
    if (command === 'clean') {
      if (flow === 'search') await deleteIndexedLoadtestProducts(createEsClient());
      if (flow === 'seller-stats') {
        const chClient = createClickHouseClient();
        await deleteLoadtestFacts(pool, chClient);
        await chClient.close();
      }
      return;
    }
    await SEEDERS[flow](pool, flags);
    log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
