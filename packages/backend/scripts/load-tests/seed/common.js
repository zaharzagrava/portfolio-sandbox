/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const DATA_DIR = path.resolve(__dirname, '../data');

require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

/** Every seeded account shares one password (see hashPassword for why). */
const LOADTEST_PASSWORD = process.env.LOADTEST_PASSWORD || 'LoadTest-Passw0rd!';
const EMAIL_DOMAIN = 'loadtest.local';

function log(...args) {
  console.log(`[seed ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function createPool() {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 4,
  });
}

/**
 * Hashed ONCE and reused for every row: bcrypt is deliberately slow
 * (~70ms at cost 10), so hashing 100k distinct passwords would take ~2h.
 * Login cost is unaffected - bcrypt.compare still does the full work per
 * request, which is exactly what the auth step of each flow measures.
 * Lower SEED_BCRYPT_ROUNDS if login throughput (not realism) is the goal.
 */
async function hashPassword() {
  const rounds = Number(process.env.SEED_BCRYPT_ROUNDS || 10);
  log(`hashing shared password (bcrypt cost ${rounds})`);
  return bcrypt.hash(LOADTEST_PASSWORD, rounds);
}

function emailPrefix(flow, role) {
  return `lt-${flow}-${role.toLowerCase()}-`;
}

/** LIKE pattern matching every account a flow ever seeded. */
function flowEmailPattern(flow) {
  return `lt-${flow}-%@${EMAIL_DOMAIN}`;
}

async function seedUsers(pool, { flow, role, count, passwordHash, batchSize = 10_000 }) {
  const prefix = emailPrefix(flow, role);
  const users = [];

  for (let offset = 0; offset < count; offset += batchSize) {
    const upper = Math.min(offset + batchSize, count);
    const { rows } = await pool.query(
      `INSERT INTO "User" (email, "passwordHash", role, "createdAt", "updatedAt")
       SELECT $1 || g || '@${EMAIL_DOMAIN}', $2, $3::"enum_User_role", NOW(), NOW()
       FROM generate_series($4::int, $5::int) AS g
       RETURNING id, email`,
      [prefix, passwordHash, role, offset + 1, upper],
    );
    users.push(...rows.map((r) => ({ userId: r.id, email: r.email })));
    log(`  ${role}: ${upper}/${count}`);
  }

  return users;
}

/** Removes everything a previous run of `flow` created, children first. */
async function cleanFlow(pool, flow) {
  const pattern = flowEmailPattern(flow);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `CREATE TEMP TABLE doomed_users ON COMMIT DROP AS
       SELECT id FROM "User" WHERE email LIKE $1`,
      [pattern],
    );
    const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM doomed_users');
    if (count === 0) {
      await client.query('ROLLBACK');
      return;
    }
    log(`cleaning ${count} users from a previous "${flow}" run`);

    // Payment -> BisOrder and LedgerEntry -> Payment are ON DELETE RESTRICT,
    // so payments/ledger have to go before the users cascade.
    await client.query(
      `CREATE TEMP TABLE doomed_payments ON COMMIT DROP AS
       SELECT p.id FROM "Payment" p
       JOIN "BisOrder" b ON b.id = p."bisOrderId"
       WHERE b."userId" IN (SELECT id FROM doomed_users)
       UNION
       SELECT p.id FROM "Payment" p
       WHERE p."userId" IN (SELECT id::text FROM doomed_users)`,
    );
    await client.query(`DELETE FROM "LedgerEntry" WHERE "paymentId" IN (SELECT id FROM doomed_payments)`);
    await client.query(`DELETE FROM "Payment" WHERE id IN (SELECT id FROM doomed_payments)`);
    // Product.sellerId is ON DELETE SET NULL - delete explicitly (cascades
    // ChatChannel/ChatChannelMember/ChatMessage/BisOrderItem).
    await client.query(`DELETE FROM "Product" WHERE "sellerId" IN (SELECT id FROM doomed_users)`);
    // Cascades BisOrder, ChatChannelMember, ChatMessage.
    await client.query(`DELETE FROM "User" WHERE id IN (SELECT id FROM doomed_users)`);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function writeData(fileName, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data));
  log(`wrote ${path.relative(BACKEND_ROOT, filePath)}`);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

module.exports = {
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
};
