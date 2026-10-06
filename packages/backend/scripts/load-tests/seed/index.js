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

const FLOWS = ['payment', 'search', 'seller-stats', 'chat'];

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
  // Lightweight delete (ClickHouse 23.3+); rows are tagged at insert time.
  await chClient.command({ query: `DELETE FROM seller_sales WHERE source = 'loadtest'` });

  const buyers = await seedUsers(pool, { flow: 'seller-stats', role: 'USER', count: userCount, passwordHash });
  const sellers = await seedUsers(pool, { flow: 'seller-stats', role: 'SELLER', count: sellerCount, passwordHash });

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
  let inserted = 0;

  const flush = async () => {
    if (!buffer.length) return;
    await chClient.insert({ table: 'seller_sales', values: buffer, format: 'JSONEachRow' });
    inserted += buffer.length;
    buffer = [];
    log(`  sales (clickhouse): ${inserted}/${totalRows}`);
  };

  for (const seller of sellers) {
    const own = productsBySeller.get(seller.userId);
    for (let i = 0; i < salesPerSeller; i++) {
      const product = pick(own);
      const quantity = randomInt(1, 3);
      buffer.push({
        ts: new Date(now - Math.random() * 120 * DAY_MS).toISOString().replace('T', ' ').replace('Z', ''),
        seller_id: seller.userId,
        product_id: product.id,
        buyer_id: pick(buyers).userId,
        order_id: crypto.randomUUID(),
        amount_cents: product.price * quantity,
        quantity,
        status: Math.random() < 0.94 ? 'COMPLETED' : 'REFUNDED',
        source: 'loadtest',
      });
      if (buffer.length >= 200_000) await flush();
    }
  }
  await flush();
  await chClient.close();

  writeData('seller-stats.json', {
    password: LOADTEST_PASSWORD,
    sellers: sellers.map((s) => s.email),
  });
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
  const ddl = fs.readFileSync(path.join(BACKEND_ROOT, 'clickhouse/001_seller_sales.sql'), 'utf8');
  await chClient.command({ query: ddl });
}

// --- --- --- --- --- Main --- --- --- --- --- //

const SEEDERS = {
  payment: seedPayment,
  search: seedSearch,
  'seller-stats': seedSellerStats,
  chat: seedChat,
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
        await chClient.command({ query: `DELETE FROM seller_sales WHERE source = 'loadtest'` });
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
