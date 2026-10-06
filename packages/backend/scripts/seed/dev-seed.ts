/**
 * Local demo data, created through the running API (so every side effect - outbox, search indexing,
 * projections - happens exactly as in production). Idempotent: re-running reuses existing users/shop.
 *
 *   pnpm --filter api seed:dev            (API_URL defaults to http://localhost:8000)
 *
 * Creates:
 *   - admin@marketplace.local  / password-1234  (role ADMIN - the only direct DB write: no API grants ADMIN)
 *   - seller@marketplace.local / password-1234  (opens the "Demo Shop", which makes them a SELLER)
 *   - a small catalog in that shop
 */
import 'dotenv/config';
import { Client } from 'pg';

const API = process.env.API_URL ?? 'http://localhost:8000';
const PASSWORD = 'password-1234';

export const SEED_USERS = {
  admin: 'admin@marketplace.local',
  seller: 'seller@marketplace.local',
};

const PRODUCTS = [
  { title: 'Wireless Noise-Cancelling Headphones', brand: 'AudioPro', category: 'electronics', price: 34999, quantity: 40, rating: 4.8 },
  { title: 'Mechanical Keyboard Cherry MX Brown', brand: 'KeyCraft', category: 'electronics', price: 14999, quantity: 25, rating: 4.6 },
  { title: 'Ultra-Wide Curved Monitor 34 inch', brand: 'DisplayTech', category: 'electronics', price: 59999, quantity: 10, rating: 4.9 },
  { title: 'Portable SSD 2TB', brand: 'DataVault', category: 'electronics', price: 17999, quantity: 60, rating: 4.7 },
  { title: 'Ergonomic Standing Desk', brand: 'WorkSpace', category: 'furniture', price: 44999, quantity: 8, rating: 4.7 },
  { title: 'Mesh Office Chair', brand: 'WorkSpace', category: 'furniture', price: 27999, quantity: 15, rating: 4.4 },
  { title: 'Espresso Machine Titanium', brand: 'BrewMaster', category: 'kitchen', price: 89999, quantity: 5, rating: 4.9 },
  { title: 'Burr Coffee Grinder', brand: 'BrewMaster', category: 'kitchen', price: 12999, quantity: 30, rating: 4.5 },
  { title: 'Running Shoes Carbon Plate', brand: 'StrideFit', category: 'sports', price: 24999, quantity: 20, rating: 4.7 },
  { title: 'Waterproof Trail Jacket', brand: 'StrideFit', category: 'sports', price: 19999, quantity: 18, rating: 4.3 },
  { title: 'Smart Home Hub Pro', brand: 'SmartLiving', category: 'electronics', price: 12999, quantity: 50, rating: 4.5 },
  { title: 'Vintage Leather Notebook', brand: 'PaperCo', category: 'stationery', price: 2999, quantity: 100, rating: 4.2 },
];

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

type Session = { accessToken: { token: string }; user: { id: string; role: string } };

/** Register, or log in when the account already exists. */
async function session(email: string): Promise<Session> {
  const registered = await call<Session>('POST', '/api/auth/register', { email, password: PASSWORD });
  if (registered.status === 201) return registered.data;
  const login = await call<Session>('POST', '/api/auth/login', { email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login ${email} failed: ${login.status} ${JSON.stringify(login.data)}`);
  return login.data;
}

async function main() {
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();
  try {
    // Already seeded? Then don't touch the API at all (logins count against the per-account login rate limit).
    const { rows: done } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Product" p JOIN "ShopMembership" m ON m."shopId" = p."shopId" JOIN "User" u ON u.id = m."userId"
       WHERE u.email = $1 AND p.title = ANY($2) AND EXISTS (SELECT 1 FROM "User" WHERE email = $3 AND role = 'ADMIN')`,
      [SEED_USERS.seller, PRODUCTS.map((p) => p.title), SEED_USERS.admin],
    );
    if (done[0].n === PRODUCTS.length) {
      console.log(`already seeded: ${SEED_USERS.admin}, ${SEED_USERS.seller} (password ${PASSWORD}), ${PRODUCTS.length} products`);
      return;
    }

    const admin = await session(SEED_USERS.admin);
    await db.query(`UPDATE "User" SET role = 'ADMIN' WHERE id = $1`, [admin.user.id]);
    console.log(`admin   ${SEED_USERS.admin} / ${PASSWORD}`);

    let seller = await session(SEED_USERS.seller);
    const mine = await call<{ id: string }[]>('GET', '/api/shops/mine', undefined, seller.accessToken.token);
    let shopId = mine.data[0]?.id;
    if (!shopId) {
      const created = await call<{ id: string }>('POST', '/api/shops', { name: 'Demo Shop', slug: `demo-shop-${Date.now().toString(36)}` }, seller.accessToken.token);
      if (created.status !== 201) throw new Error(`create shop failed: ${created.status} ${JSON.stringify(created.data)}`);
      shopId = created.data.id;
      seller = await session(SEED_USERS.seller); // fresh token carrying the SELLER role
    }
    console.log(`seller  ${SEED_USERS.seller} / ${PASSWORD}  shop ${shopId}`);

    const { rows } = await db.query<{ title: string }>(`SELECT title FROM "Product" WHERE "shopId" = $1`, [shopId]);
    const existing = new Set(rows.map((r) => r.title));
    let created = 0;
    for (const p of PRODUCTS.filter((p) => !existing.has(p.title))) {
      const res = await call('POST', `/api/products/shops/${shopId}`, { ...p, description: `${p.title} by ${p.brand}. Demo product.`, tags: [p.category] }, seller.accessToken.token);
      if (res.status !== 201) throw new Error(`create product "${p.title}" failed: ${res.status} ${JSON.stringify(res.data)}`);
      created++;
    }
    console.log(`products: ${created} created, ${existing.size} already present`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
