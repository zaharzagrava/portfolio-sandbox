import { expect, type Page } from '@playwright/test';

export const API_URL = process.env.API_URL ?? 'http://localhost:8000';

/** Created by `pnpm --filter api seed:dev` (global setup). */
export const SEED = {
  admin: 'admin@marketplace.local',
  seller: 'seller@marketplace.local',
  password: 'password-1234',
  product: 'Espresso Machine Titanium',
};

export const uniqueEmail = (prefix = 'ui') => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

/** Registers through the UI; lands on the home page signed in. */
export async function register(page: Page, email = uniqueEmail()) {
  const password = 'SuperSecurePassword123!';
  await page.goto('/register');
  await page.fill('input[name="name"]', 'UI Test User');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.fill('input[name="confirmPassword"]', password);
  await page.locator('button[id="terms"]').click();
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('http://localhost:3000/');
  return { email, password };
}

export async function login(page: Page, email: string, password: string, returnUrl = '/') {
  await page.goto(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(new RegExp(`${returnUrl.replace(/[?]/g, '\\?')}$`));
}

/** A seeded product's id, found through the real search API (indexing is asynchronous, so poll briefly). */
export async function productId(title = SEED.product): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`${API_URL}/api/products/search?q=${encodeURIComponent(title)}`);
    if (res.ok) {
      const body = (await res.json()) as { hits: { id: string; source: { title?: string } }[] };
      const hit = body.hits.find((h) => h.source.title === title);
      if (hit) return hit.id;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`"${title}" is not searchable - is the worker/indexer running (dev-monolith)?`);
}
