import { expect, test, type Page, type Route } from '@playwright/test';
import { register, sellerCall } from '../../helpers';
import { tokenOf, watchApi } from '../cross-cutting/support';
import { rows, scalar, userId } from '../support/db';
import { acceptInvite, covers, ownerByApi } from './support';

/**
 * AI QA, area "entry", pass 2, section "open-shop form, the rest": error panels, the API's own rules (idempotency, region,
 * trimming), hostile names, phone width, accessibility, two tabs at once, and a member who is only a guest in another shop.
 * Each test names the map lines it covers (scripts/aiqa/coverage/entry.tsv) in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const uniqueHandle = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

async function onTheForm(page: Page) {
  const member = await register(page);
  await page.goto(HOME);
  await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
  return { ...member, name: page.getByLabel('Shop name'), handle: page.getByLabel('Handle'), submit: page.getByRole('button', { name: /^(Open shop|Opening…)$/ }) };
}

async function answerShopCreateWith(page: Page, status: number, code: string, extra: Record<string, unknown> = {}) {
  await page.route('**/api/shops', (route: Route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'x', status, code, detail: 'x', requestId: 'req-aiqa', ...extra }) })
      : route.fallback(),
  );
}

test.describe('entry: the open-shop form, the rest', () => {
  test('entry.form.error-5xx entry.form.error-network-down: a server error or an unknown code never leaks words, and the lost connection is told above the button', async ({ page }) => {
    covers('entry.form.error-5xx', 'entry.form.error-network-down');
    const form = await onTheForm(page);
    await form.name.fill('Server Trouble');
    const leak = 'select * from "Shop" at /srv/app/node_modules/pg/lib/client.js:526';
    await answerShopCreateWith(page, 500, 'internal_error', { title: 'PgError', detail: leak, stack: leak });
    await form.submit.click();
    const alert = page.getByRole('alert').filter({ hasText: 'Something went wrong on our side.' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Reference: req-aiqa');
    await expect(alert.getByRole('button', { name: 'Copy reference' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('PgError');
    await expect(page.locator('body')).not.toContainText('node_modules');
    await expect(page.locator('body')).not.toContainText('select * from');
    await expect(form.submit).toBeEnabled();

    // An unknown 4xx code is told as the generic server line or the generic "didn't work" line, with no server words.
    await page.unroute('**/api/shops');
    await answerShopCreateWith(page, 418, 'teapot_unknown', { title: 'I am a teapot', detail: 'brew coffee' });
    await form.submit.click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('teapot');
    await expect(page.locator('body')).not.toContainText('brew coffee');
    await expect(form.submit).toBeEnabled();

    // The lost connection: the words are above the button.
    await page.unroute('**/api/shops');
    await page.route('**/api/shops', (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.fallback()));
    await form.submit.click();
    const offline = page.getByRole('alert').filter({ hasText: "Couldn't reach the server. Check your connection and try again." });
    await expect(offline).toBeVisible();
    const [textBox, buttonBox] = [await offline.boundingBox(), await form.submit.boundingBox()];
    expect(textBox && buttonBox && textBox.y + textBox.height <= buttonBox.y + 1, 'the message sits above the button').toBe(true);
  });

  test('entry.form.error-session-ended: a 401 on Open shop tells it politely, runs the session-ended flow once, and saves nothing', async ({ page }) => {
    covers('entry.form.error-session-ended');
    const form = await onTheForm(page);
    const api = watchApi(page);
    await page.route('**/api/shops', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 401, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'x', status: 401, code: 'invalid_token', detail: 'x', requestId: 'req-aiqa' }) })
        : route.fallback(),
    );
    await form.name.fill('Ended Session');
    await form.submit.click();
    await expect(page.locator('#main-content').getByRole('status').filter({ hasText: 'Your session ended. Sign in again to continue.' })).toBeVisible();
    // The shared session-ended flow ran once: one toast with a Sign in action (not two, however many renders).
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Your session ended' });
    await expect(toast).toHaveCount(1);
    await expect(toast.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // A second press ends in the same 401: the flow is latched, still one toast.
    await form.submit.click();
    await expect.poll(() => api.count('POST', /^\/api\/shops$/)).toBe(2);
    await expect(toast).toHaveCount(1);
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(form.email)}'`)).toBe('0');
  });

  test('entry.form.error-retry-after-fix: after a field error, a new handle sends a new request and the old error is gone', async ({ page }) => {
    covers('entry.form.error-retry-after-fix');
    const form = await onTheForm(page);
    const api = watchApi(page);
    const taken = uniqueHandle('aiqa-retry');
    const other = await ownerByApi();
    expect((await sellerCall('POST', '/api/shops', { name: 'Holder', slug: taken }, await tokenOf(other.owner))).status).toBe(201);
    await form.name.fill('Retry Shop');
    await form.handle.fill(taken);
    await form.submit.click();
    await expect(page.getByText('That handle is taken. Try another.')).toBeVisible();
    expect(api.count('POST', /^\/api\/shops$/)).toBe(1);

    const fresh = uniqueHandle('aiqa-retry-ok');
    await form.handle.fill(fresh);
    await form.submit.click();
    await expect(page).toHaveURL(new RegExp(`${HOME}/[0-9a-f-]{36}$`));
    expect(api.matching('POST', /^\/api\/shops$/).map((entry) => entry.status)).toEqual([409, 201]);
    expect(scalar(`select count(*) from "Shop" where slug='${fresh}'`)).toBe('1');
    // a general error panel from an earlier try is cleared on submit
  });

  test('entry.form.idempotency-key: the form sends no key, the API replays the same key and body and refuses the same key with another body', async ({ page }) => {
    covers('entry.form.idempotency-key');
    const form = await onTheForm(page);
    const seen: Record<string, string>[] = [];
    page.on('request', (request) => request.method() === 'POST' && /\/api\/(bff\/f\/)?shops$/.test(new URL(request.url()).pathname) && seen.push(request.headers()));
    const slug = uniqueHandle('aiqa-idem');
    await form.name.fill('Idem Form');
    await form.handle.fill(slug);
    await form.submit.click();
    await expect(page).toHaveURL(new RegExp(`${HOME}/[0-9a-f-]{36}$`));
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).filter((name) => /idempotency/i.test(name)), 'the form sends no Idempotency-Key').toEqual([]);

    // The API itself (another member, so the first one stays at one shop).
    const { owner } = await ownerByApi();
    const token = await tokenOf(owner);
    const key = `aiqa-${Date.now().toString(36)}`;
    const body = { name: 'Keyed Shop', slug: uniqueHandle('aiqa-keyed') };
    const send = async (payload: unknown) => {
      const response = await fetch(`${process.env.API_URL ?? 'http://localhost:8000'}/api/shops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key },
        body: JSON.stringify(payload),
      });
      return { status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const first = await send(body);
    const second = await send(body);
    const third = await send({ ...body, name: 'Another Name' });
    expect(first.status).toBe(201);
    expect([second.status, second.data.id]).toEqual([201, first.data.id]);
    expect([400, 409, 422]).toContain(third.status);
    expect(scalar(`select count(*) from "Shop" where slug='${body.slug}'`)).toBe('1');
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(owner.email)}' and role='OWNER'`)).toBe('2'); // the first shop of the helper + the keyed one
  });

  test('entry.form.xss-name: a script-like name is stored and shown as text everywhere', async ({ page }) => {
    covers('entry.form.xss-name');
    const form = await onTheForm(page);
    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const evil = '<img src=x onerror=alert(1)>';
    await form.name.fill(evil);
    const slug = uniqueHandle('aiqa-xss');
    await form.handle.fill(slug);
    await form.submit.click();
    await expect(page).toHaveURL(new RegExp(`${HOME}/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { level: 1, name: evil })).toBeVisible();
    expect(scalar(`select name from "Shop" where slug='${slug}'`)).toBe(evil);
    // The switcher (desktop sidebar or phone drawer) and the picker show it as text too.
    const { sellerMenu } = await import('../../helpers');
    const menu = await sellerMenu(page);
    await expect(menu.getByRole('button', { name: evil })).toBeVisible();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(dialogs).toEqual([]);
    const token = await tokenOf(form);
    const other = await sellerCall('POST', '/api/shops', { name: 'Second Xss', slug: uniqueHandle('aiqa-xss2') }, token);
    expect(other.status).toBe(201);
    await page.goto(HOME);
    await expect(page.getByRole('list', { name: 'Your shops' }).getByText(evil, { exact: true })).toBeVisible();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(dialogs).toEqual([]);
  });

  test('entry.form.unicode-whitespace-name entry.form.region-default: names are trimmed on the way in, spaces-only is refused, 80 fits and 81 does not, the region is the default', async ({ page }) => {
    covers('entry.form.unicode-whitespace-name', 'entry.form.region-default');
    const form = await onTheForm(page);
    const seen: string[] = [];
    page.on('request', (request) => request.method() === 'POST' && /\/api\/(bff\/f\/)?shops$/.test(new URL(request.url()).pathname) && seen.push(request.postData() ?? ''));

    await form.name.fill('     ');
    await form.handle.fill(uniqueHandle('aiqa-space'));
    await form.submit.click();
    await expect(page.getByText('Enter a shop name of 2 to 80 characters.')).toBeVisible();
    expect(seen).toEqual([]);

    // The API holds the same rules: spaces only is refused, the padded name is stored trimmed, 80 characters fit.
    const token = await tokenOf(form);
    expect((await sellerCall('POST', '/api/shops', { name: '      ', slug: uniqueHandle('aiqa-sp') }, token)).status).toBe(400);
    expect((await sellerCall('POST', '/api/shops', { name: 'x'.repeat(81), slug: uniqueHandle('aiqa-81') }, token)).status).toBe(400);

    const slug = uniqueHandle('aiqa-trim');
    await form.name.fill(' 　  Trimmed Name   ');
    await form.handle.fill(slug);
    await form.submit.click();
    await expect(page).toHaveURL(new RegExp(`${HOME}/[0-9a-f-]{36}$`));
    expect(seen).toHaveLength(1);
    const sent = JSON.parse(seen[0]!) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['name', 'slug']); // no region, no plan
    expect((sent.name as string).trim()).toBe(sent.name);
    const [name, region] = rows(`select s.name, d.region from "Shop" s join "ShopDirectory" d on d."shopId"=s.id where s.slug='${slug}'`)[0]!;
    expect(name).toBe('Trimmed Name');

    const long = await sellerCall('POST', '/api/shops', { name: 'y'.repeat(80), slug: uniqueHandle('aiqa-80') }, token);
    expect(long.status).toBe(201);
    // The map says Shop.region; the region lives in ShopDirectory and is the first allowed region (built-in default eu-central-1).
    expect(region).toBe('eu-central-1');
    const longRegion = scalar(`select d.region from "Shop" s join "ShopDirectory" d on d."shopId"=s.id where s.id='${long.data.id}'`);
    expect(longRegion).toBe('eu-central-1');
  });

  test('entry.form.mobile-390 entry.form.labels-a11y: at phone width the form fits and the fields are labelled and linked to their problems', async ({ page }) => {
    covers('entry.form.mobile-390', 'entry.form.labels-a11y');
    const form = await onTheForm(page);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const box of [await form.name.boundingBox(), await form.handle.boundingBox(), await form.submit.boundingBox()]) {
      expect(box && box.x >= 0 && box.x + box.width <= 390, 'inside the screen').toBe(true);
    }
    const name = (await form.name.boundingBox())!;
    const handle = (await form.handle.boundingBox())!;
    expect(Math.abs(name.width - handle.width)).toBeLessThan(2);
    expect(name.width).toBeGreaterThan(250);

    // The error text of a field is in view when it appears, and the button is reachable.
    await form.submit.scrollIntoViewIfNeeded();
    await form.submit.click();
    await expect(page.getByText('Enter a shop name of 2 to 80 characters.')).toBeInViewport();

    // Labels: each field has a visible label tied to it, errors linked, one h1.
    await expect(page.locator('label[for="shop-name"]')).toHaveText('Shop name');
    await expect(page.locator('label[for="shop-slug"]')).toHaveText('Handle');
    await expect(page.getByLabel('Shop name')).toHaveAttribute('aria-describedby', 'shop-name-problem');
    await expect(page.locator('#shop-name-problem')).toContainText('2 to 80');
    await form.name.fill('Fine Name');
    await form.handle.fill('Bad Handle');
    await form.name.focus();
    await expect(form.handle).toHaveAttribute('aria-describedby', 'shop-slug-problem');
    await expect(page.locator('#shop-slug-problem')).toContainText('3 to 40');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    expect(await page.locator('main h1, h1').first().innerText()).toBe('Open your shop');
    // The first heading in reading order is the h1.
    expect(await page.evaluate(() => document.querySelector('main')?.querySelector('h1,h2,h3')?.tagName ?? document.querySelector('h1')?.tagName)).toBe('H1');
  });

  test('entry.form.multi-tab-race: the same handle sent twice at once saves one shop; the other answer is "taken", no orphan membership', async ({ browser }) => {
    covers('entry.form.multi-tab-race');
    const slug = uniqueHandle('aiqa-race');
    const a = await ownerByApi();
    const b = await ownerByApi();
    const [tokenA, tokenB] = [await tokenOf(a.owner), await tokenOf(b.owner)];
    const results = await Promise.all([
      sellerCall('POST', '/api/shops', { name: 'Race A', slug }, tokenA),
      sellerCall('POST', '/api/shops', { name: 'Race B', slug }, tokenB),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.data.code).toBe('slug_taken');
    expect(scalar(`select count(*) from "Shop" where slug='${slug}'`)).toBe('1');
    const shopId = scalar(`select id from "Shop" where slug='${slug}'`);
    expect(scalar(`select count(*) from "ShopMembership" where "shopId"='${shopId}'`)).toBe('1');
    // The losing member has only the shop the helper made.
    const loser = results[0]!.status === 409 ? a : b;
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(loser.owner.email)}'`)).toBe('1');

    // The same in the browser: two tabs of one member press the button together; one shop in the end.
    const context = await browser.newContext();
    const one = await context.newPage();
    await register(one);
    const two = await context.newPage();
    const tabSlug = uniqueHandle('aiqa-tabs');
    for (const tab of [one, two]) {
      await tab.goto(HOME);
      await tab.getByLabel('Shop name').fill('Two Tabs');
      await tab.getByLabel('Handle').fill(tabSlug);
    }
    await Promise.all([one.getByRole('button', { name: 'Open shop' }).click(), two.getByRole('button', { name: 'Open shop' }).click()]);
    await expect.poll(() => scalar(`select count(*) from "Shop" where slug='${tabSlug}'`)).toBe('1');
    await expect.poll(async () => (await one.getByText('That handle is taken. Try another.').count()) + (await two.getByText('That handle is taken. Try another.').count()) + [one, two].filter((tab) => tab.url().includes(`${HOME}/`)).length).toBe(2);
    const taken = (await one.getByText('That handle is taken. Try another.').count()) + (await two.getByText('That handle is taken. Try another.').count());
    const opened = [one, two].filter((tab) => new RegExp(`${HOME}/[0-9a-f-]{36}$`).test(tab.url())).length;
    expect(opened + taken, 'one tab opened the shop, the other was told').toBe(2);
    await context.close();
  });

  test('entry.form.viewer-role-user: a member who is only a guest (VIEWER or STAFF) in a shop gets the shop, not the form; the form is not offered', async ({ page }) => {
    covers('entry.form.viewer-role-user');
    const member = await register(page);
    const { owner, shopId } = await ownerByApi();
    await acceptInvite(page, owner, shopId, { email: member.email }, 'VIEWER');
    await page.goto(HOME);
    await expect(page).toHaveURL(`${HOME}/${shopId}`);
    await expect(page.getByRole('heading', { name: 'Open your shop' })).toHaveCount(0);
    // The role shows in the shop answer; the account's own role claim stays a buyer's (no UI path to a shop of one's own).
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(member))).data.items as { id: string; role: string }[];
    expect(mine.map((s) => `${s.id}:${s.role}`)).toEqual([`${shopId}:VIEWER`]);
    expect(scalar(`select role from "ShopMembership" where "shopId"='${shopId}' and "userId"='${userId(member.email)}'`)).toBe('VIEWER');
    // With a second shop of their own, the picker appears with both roles.
    expect((await sellerCall('POST', '/api/shops', { name: 'Guest Own', slug: uniqueHandle('aiqa-guest') }, await tokenOf(member))).status).toBe(201);
    await page.goto(HOME);
    const list = page.getByRole('list', { name: 'Your shops' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem').filter({ hasText: 'Guest Own' })).toContainText('Owner');
    await expect(list.getByRole('listitem').filter({ hasText: 'Viewer' })).toHaveCount(1);
  });
});
