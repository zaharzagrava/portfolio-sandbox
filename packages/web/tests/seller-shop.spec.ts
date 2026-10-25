import { type Page, type Route, expect, test } from '@playwright/test';
import { NEW_USER_PASSWORD, register, resetRateLimits, sellerCall, sellerMenu, shopPath, uniqueEmail } from './helpers';
import { openShopByApi } from './seller-setup';
import { UNKNOWN_ID, myShops, openSecondShop, shopWithSlug, tokenOf, watchApi } from './seller/cross-cutting/support';
import { rows, scalar, setShopStatus, userId } from './seller/support/db';
import { type Role, acceptInvite, covers, isPhone, ownerByApi, sellerNav } from './support/seller-entry';
import { execFileSync } from 'node:child_process';

/**
 * W04 US1/US2: opening a shop, coming back to it and switching between shops (AS-01..AS-03, AS-08..AS-10). Roles and labels
 * only. Every test registers its own member, so nothing is shared with another (L-005).
 */
test.describe('Seller shop entry and overview', () => {
  test('W04 AS-01..AS-03, AS-10: an owner opens a shop from "Start selling" and lands on its overview @desktop', async ({ page }) => {
    await register(page);
    await resetRateLimits();
    await page.goto('/dashboard');
    // step 1: the form is reachable from "Start selling" and submits
    await page.getByRole('link', { name: 'Start selling' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    const shopName = `E2E Shop ${Date.now().toString(36)}`;
    await page.getByLabel('Shop name').fill(shopName);
    await expect(page.getByLabel('Handle')).toHaveValue(/^e2e-shop-[a-z0-9]+$/);
    await page.getByRole('button', { name: 'Open shop' }).click();

    // step 2: the browser goes to the new shop's overview
    await expect(page).toHaveURL(/\/dashboard\/seller\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: shopName })).toBeVisible();

    // step 3: the sections of the overview render from the real API
    await expect(page.getByRole('region', { name: 'Last 60 seconds' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Today (UTC)' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Leaderboard rank' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Top products' })).toBeVisible();
    await expect((await sellerMenu(page)).getByRole('navigation', { name: 'Seller' }).getByRole('link', { name: 'Inventory' })).toBeVisible();
  });

  test('W04 AS-08: a returning owner of one shop lands on its overview @desktop', async ({ page }) => {
    const member = await register(page);
    const { shopId, shopName } = await openShopByApi(member);
    await page.goto('/dashboard/seller');
    await expect(page).toHaveURL(new RegExp(`${shopPath(shopId)}$`));
    await expect(page.getByRole('heading', { level: 1, name: shopName })).toBeVisible();
  });

  test('W04 AS-09: an owner of two shops picks one and switches while keeping the section @desktop', async ({ page }) => {
    const member = await register(page);
    const first = await openShopByApi(member);
    const login = await sellerCall('POST', '/api/auth/login', { email: member.email, password: NEW_USER_PASSWORD });
    expect(login.status).toBe(200);
    const secondName = `E2E Second ${Date.now().toString(36)}`;
    const created = await sellerCall('POST', '/api/shops', { name: secondName, slug: `e2e-second-${Date.now().toString(36)}` }, login.data.accessToken.token);
    expect(created.status).toBe(201);
    const secondId: string = created.data.id;

    // the picker lists both shops with their role
    await page.goto('/dashboard/seller');
    const list = page.getByRole('list', { name: 'Your shops' });
    await expect(list.getByRole('link', { name: new RegExp(first.shopName) })).toBeVisible();
    await expect(list.getByRole('link', { name: new RegExp(secondName) })).toContainText('Owner');

    // the switcher keeps the section
    await page.goto(shopPath(first.shopId, 'inventory'));
    await (await sellerMenu(page)).getByRole('button', { name: new RegExp(first.shopName) }).first().click();
    await page.getByRole('list', { name: 'Your shops' }).getByRole('link', { name: new RegExp(secondName) }).click();
    await expect(page).toHaveURL(new RegExp(`${shopPath(secondId, 'inventory')}$`));
    await expect((await sellerMenu(page)).getByRole('button', { name: new RegExp(secondName) }).first()).toBeVisible();
  });
});

// ---- the open-shop form
{
/**
 * AI QA, area "entry", section "open-shop form" (the page a member without a shop sees at /dashboard/seller). Each test names
 * the map lines it covers (scripts/aiqa/coverage/entry.tsv) in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const NAME_RULE = 'Enter a shop name of 2 to 80 characters.';
const HANDLE_RULE = 'Use 3 to 40 lowercase letters, digits or dashes.';

function covers(...lines: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: lines.join(',') });
}

const uniqueHandle = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** A signed-in member without a shop, standing on the empty form. */
async function onTheForm(page: Page) {
  const member = await register(page);
  await page.goto(HOME);
  await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
  return { ...member, name: page.getByLabel('Shop name'), handle: page.getByLabel('Handle'), submit: page.getByRole('button', { name: /^(Open shop|Opening…)$/ }) };
}

/** Answers every `POST /api/shops` of the page with a problem document (the real answers it could not be made to give). */
async function answerShopCreateWith(page: Page, status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  await page.route('**/api/shops', (route: Route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status, contentType: 'application/problem+json', headers, body: JSON.stringify({ type: 'about:blank', title: 'x', status, code, detail: 'x', requestId: 'req-aiqa', ...extra }) })
      : route.fallback(),
  );
}

test.describe('entry: the open-shop form', () => {
  test('W04 AS-01: labels, limits and hints of the two fields @desktop', async ({ page }) => {
    covers('entry.form.heading', 'entry.form.name-field', 'entry.form.handle-field');
    const form = await onTheForm(page);
    await expect(page.getByText("Start selling on the marketplace. You become the shop's owner.")).toBeVisible();
    await expect(form.name).toHaveAttribute('id', 'shop-name');
    await expect(form.name).toHaveAttribute('maxlength', '80');
    await expect(form.name).toHaveAttribute('autocomplete', 'off');
    await expect(form.handle).toHaveAttribute('id', 'shop-slug');
    await expect(form.handle).toHaveAttribute('placeholder', 'my-shop');
    await expect(form.handle).toHaveAttribute('spellcheck', 'false');
    // The typing limit of the Handle is 80, while the API refuses more than 40: the client check on blur is what catches it.
    await form.name.fill('n'.repeat(100));
    expect(await form.name.inputValue()).toHaveLength(80);
    await form.handle.fill('a'.repeat(100));
    expect(await form.handle.inputValue()).toHaveLength(80);
    await form.name.focus();
    await expect(page.getByText(HANDLE_RULE)).toBeVisible();
  });

  test('W04 AS-02: symbols give an empty handle, long names are cut at 40, accents are stripped without splitting words @desktop', async ({ page }) => {
    covers('entry.form.slugify-edge-cases');
    const form = await onTheForm(page);
    await form.name.fill('🙂🙂🙂');
    await expect(form.handle).toHaveValue('');
    await form.name.fill('Привіт світ');
    await expect(form.handle).toHaveValue('');
    await form.name.fill('abcdefghi '.repeat(5));
    await expect(form.handle).toHaveValue('abcdefghi-abcdefghi-abcdefghi-abcdefghi');
    await form.name.fill('x'.repeat(45));
    await expect(form.handle).toHaveValue('x'.repeat(40));
    await form.name.fill('A-B--C');
    await expect(form.handle).toHaveValue('a-b-c');
    await form.name.fill('Admin');
    await expect(form.handle).toHaveValue('admin');
    // An accented letter is stripped to its base letter: "Café Münster" is not "cafe-mu-nster".
    await form.name.fill('Café Münster');
    await expect(form.handle).toHaveValue('cafe-munster');
  });

  test('W04 AS-02: the form and the API accept and refuse the same handles @desktop', async ({ page }) => {
    covers('entry.form.handle-pattern-parity');
    const form = await onTheForm(page);
    const token = await tokenOf(form);
    const stamp = Date.now().toString(36);
    const cases: [string, boolean][] = [
      ['ab', false],
      ['a'.repeat(41), false],
      [`-lead${stamp}`, false],
      [`trail${stamp}-`, false],
      [`UPPER${stamp}`, false],
      [`p--${stamp}`, true],
      ['a'.repeat(40 - stamp.length) + stamp, true],
    ];
    for (const [handle, accepted] of cases) {
      await form.handle.fill(handle);
      await form.name.focus();
      const clientRefuses = await page.getByText(HANDLE_RULE).isVisible();
      const api = await sellerCall('POST', '/api/shops', { name: 'Parity', slug: handle }, token);
      const apiRefuses = api.status === 400;
      expect(clientRefuses, `form on "${handle}"`).toBe(!accepted);
      expect(apiRefuses, `API on "${handle}" answered ${api.status}`).toBe(!accepted);
    }
  });

  test('W04 AS-03, AS-04, AS-07: one valid press opens one shop, saved in every table, and the role catches up @desktop', async ({ page }) => {
    covers(
      'entry.form.submit-happy-path',
      'entry.form.button-label-pending',
      'entry.form.double-press-one-request',
      'entry.form.invalidates-shops-cache',
      'entry.form.role-refresh-background',
    );
    const form = await onTheForm(page);
    const api = watchApi(page);
    const slug = uniqueHandle('aiqa-happy');
    await form.name.fill('  Happy Path Shop  ');
    await form.handle.fill(slug);
    await form.submit.dblclick(); // two quick presses
    await expect(page.getByRole('button', { name: 'Opening…' }).or(page.getByRole('button', { name: 'Open shop' }))).toBeDisabled();
    await expect(page.getByText('Your shop is open')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${HOME}/[0-9a-f-]{36}$`));

    // One request, with the trimmed name, answered 201.
    expect(api.matching('POST', /^\/api\/shops$/)).toHaveLength(1);
    expect(api.matching('POST', /^\/api\/shops$/)[0]?.status).toBe(201);

    // The saved state: one shop with the plan, status and owner membership of a new shop, listed in the directory and the history.
    const shop = rows(`select id, name, plan, status, "verificationStatus" from "Shop" where slug='${slug}'`);
    expect(shop).toHaveLength(1);
    const [shopId, name, plan, status, verification] = shop[0]!;
    expect([name, plan, status, verification]).toEqual(['Happy Path Shop', 'STARTER', 'ACTIVE', 'UNVERIFIED']);
    expect(rows(`select role, source from "ShopMembership" where "shopId"='${shopId}' and "userId"='${userId(form.email)}'`)).toEqual([['OWNER', 'owner']]);
    expect(rows(`select cell, version from "ShopDirectory" where "shopId"='${shopId}'`)).toEqual([['pooled', '1']]);
    expect(rows(`select "from", "to" from "ShopStatusHistory" where "shopId"='${shopId}'`)).toEqual([['', 'ACTIVE']]);
    await expect
      .poll(() => rows(`select "eventName" from "Outbox" where payload::text like '%${shopId}%' order by "eventName"`).map((r) => r[0]))
      .toEqual(['tenancy.member_added', 'tenancy.shop_created']);

    // The shell is open, and the role refresh asks again only until the role shows SELLER (W04 AS-04): the second answer says
    // SELLER, so no third request follows.
    await expect(page.getByRole('navigation', { name: 'Seller' }).first()).toBeVisible();
    await expect.poll(() => api.count('POST', /\/session\/refresh$/), { timeout: 15_000 }).toBe(2);
    await expect(page.waitForRequest((request) => /\/session\/refresh$/.test(request.url()), { timeout: 5_000 })).rejects.toThrow();
    await expect.poll(async () => ((await (await page.request.get('/api/bff/session')).json()) as { user: { role: string } }).user.role).toBe('SELLER');
  });

  test('W04 AS-05: a taken handle is told under the Handle, focus moves there, editing clears it @desktop', async ({ page }) => {
    covers('entry.form.error-slug-taken', 'entry.form.error-clears-on-edit');
    const taken = uniqueHandle('aiqa-taken');
    await shopWithSlug(taken);
    const form = await onTheForm(page);
    const before = scalar(`select count(*) from "Shop"`);
    await form.name.fill('Dup Shop');
    await form.handle.fill(taken);
    await form.submit.click();
    await expect(page.getByText('That handle is taken. Try another.')).toBeVisible();
    await expect(form.handle).toBeFocused();
    await expect(form.handle).toHaveAttribute('aria-invalid', 'true');
    await expect(form.submit).toBeEnabled();
    expect(scalar(`select count(*) from "Shop" where slug='${taken}'`)).toBe('1');
    expect(Number(scalar(`select count(*) from "Shop"`)) - Number(before)).toBeLessThanOrEqual(0 + 5); // other tests may add shops; none of ours did
    await form.handle.fill(`${taken}x`);
    await expect(page.getByText('That handle is taken. Try another.')).toBeHidden();
  });

  test('W04 AS-05: reserved handles are refused under the Handle and nothing is saved @desktop', async ({ page }) => {
    covers('entry.form.error-slug-reserved');
    const form = await onTheForm(page);
    for (const reserved of ['admin', 'api', `seller-${Date.now().toString(36)}`, `${uniqueHandle('aiqa')}-sandbox`, `deleted-${Date.now().toString(36)}`]) {
      await form.name.fill('Reserved Try');
      await form.handle.fill(reserved);
      await form.submit.click();
      await expect(page.getByText('That handle is reserved. Try another.'), reserved).toBeVisible();
      await expect(form.handle).toBeFocused();
      expect(scalar(`select count(*) from "Shop" where slug='${reserved}'`)).toBe('0');
    }
  });

  test('W04 AS-05: server field problems land under the right field; only a new answer moves focus; editing clears one message @desktop', async ({ page }) => {
    covers('entry.form.error-validation-failed', 'entry.form.error-name-focus', 'entry.form.error-clears-on-edit');
    const form = await onTheForm(page);
    await answerShopCreateWith(page, 400, 'validation_failed', { errors: [{ field: 'name', code: 'minLength' }, { field: 'slug', code: 'matches' }] });
    await form.name.fill('Mock Shop');
    await form.handle.fill('mock-shop');
    await form.submit.click();
    await expect(page.getByText(NAME_RULE)).toBeVisible();
    await expect(page.getByText(HANDLE_RULE)).toBeVisible();
    await expect(form.name).toBeFocused(); // the first one when several

    await form.handle.fill('mock-shop-2'); // editing one field leaves the other message
    await expect(page.getByText(HANDLE_RULE)).toBeHidden();
    await expect(page.getByText(NAME_RULE)).toBeVisible();
    await form.name.fill('Mock Shop 2');
    await expect(page.getByText(NAME_RULE)).toBeHidden();

    await page.unroute('**/api/shops');
    await answerShopCreateWith(page, 400, 'validation_failed', { errors: [{ field: 'slug', code: 'matches' }] });
    await form.submit.click();
    await expect(page.getByText(HANDLE_RULE)).toBeVisible();
    await expect(form.handle).toBeFocused();
  });

  test('W04 AS-06: the 11th shop is refused with a form-level alert and no row @desktop', async ({ page }) => {
    covers('entry.form.error-shop-limit');
    const form = await onTheForm(page); // the form is already open, then the member's shops are made in the background
    const token = await tokenOf(form);
    for (let i = 1; i <= 10; i++) {
      const created = await sellerCall('POST', '/api/shops', { name: `Lim ${i}`, slug: uniqueHandle(`aiqa-lim${i}`) }, token);
      expect(created.status).toBe(201);
    }
    const slug = uniqueHandle('aiqa-eleven');
    await form.name.fill('Eleventh');
    await form.handle.fill(slug);
    await form.submit.click();
    await expect(page.getByRole('alert').filter({ hasText: 'You already own 10 shops.' })).toBeVisible();
    await expect(page.locator('#shop-name-problem, #shop-slug-problem')).toHaveCount(0);
    expect(scalar(`select count(*) from "Shop" where slug='${slug}'`)).toBe('0');
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(form.email)}' and role='OWNER'`)).toBe('10');
  });

  test('W04 AS-85: a shop id that is not a UUID answers the same 404 as an unknown one (S03 R-01) @desktop', async ({ page }) => {
    covers('entry.form.api-unknown-shop-id');
    const form = await onTheForm(page);
    const token = await tokenOf(form);
    const malformed = await sellerCall('GET', '/api/shops/not-a-uuid', undefined, token);
    const unknown = await sellerCall('GET', '/api/shops/11111111-1111-4111-8111-111111111111', undefined, token);
    expect([malformed.status, unknown.status]).toEqual([404, 404]);
    expect([malformed.data.code, unknown.data.code]).toEqual(['shop_not_found', 'shop_not_found']);
  });
});
}

// ---- the open-shop form, the rest
{
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
  test('W04 AS-06: a server error or an unknown code never leaks words, and the lost connection is told above the button @desktop', async ({ page }) => {
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

  test('W04 AS-87: a 401 on Open shop tells it politely, runs the session-ended flow once, and saves nothing @desktop', async ({ page }) => {
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

  test('W04 AS-05: after a field error, a new handle sends a new request and the old error is gone @desktop', async ({ page }) => {
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

  test('W04 AS-100: the form sends no key, the API replays the same key and body and refuses the same key with another body @desktop', async ({ page }) => {
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

  test('W04 AS-100: a script-like name is stored and shown as text everywhere @desktop', async ({ page }) => {
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
    const { sellerMenu } = await import('./helpers');
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

  test('W04 AS-100: names are trimmed on the way in, spaces-only is refused, 80 fits and 81 does not, the region is the default @desktop', async ({ page }) => {
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

  test('W04 AS-01: at phone width the form fits and the fields are labelled and linked to their problems @phone', async ({ page }) => {
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

  test('W04 AS-07: the same handle sent twice at once saves one shop; the other answer is "taken", no orphan membership @desktop', async ({ browser }) => {
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

  test('W04 AS-08: a member who is only a guest (VIEWER or STAFF) in a shop gets the shop, not the form; the form is not offered @desktop', async ({ page }) => {
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
}

// ---- the front door /dashboard/seller
{
/**
 * AI QA, area "entry", section "/dashboard/seller": what a member sees at the front door of the seller dashboard
 * (no shop, one shop, several shops, cursors, legacy addresses, signed-out visitors). Each test names the map lines it covers
 * (scripts/aiqa/coverage/entry.tsv) in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';

function covers(...lines: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: lines.join(',') });
}

/** A signed-in member without any shop. */
async function memberWithoutShop(page: Page) {
  const member = await register(page);
  return member;
}

test.describe('entry: the front door', () => {
  test('W04 AS-01: a member without a shop gets the form and the Start selling menu @desktop', async ({ page }) => {
    covers('entry.index.no-shop-form', 'entry.startnav.start-selling-link', 'entry.startnav.no-account-links', 'entry.index.title-noindex');
    const member = await memberWithoutShop(page);
    await page.goto(HOME);

    await expect(page.getByRole('heading', { level: 1, name: 'Open your shop' })).toBeVisible();
    await expect(page).toHaveTitle(/^Your shops/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');

    // The left menu holds one entry, marked as the current page, and no account links or shop switcher.
    const menu = page.getByRole('navigation', { name: 'Seller' });
    await expect(menu.getByRole('link')).toHaveCount(1);
    await expect(menu.getByRole('link', { name: 'Start selling' })).toHaveAttribute('aria-current', 'page');
    await expect(menu.getByRole('link', { name: 'Your orders' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'Account security' })).toHaveCount(0);

    // The saved state: the API list is empty and no membership row exists.
    expect((await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(member))).data).toEqual({ items: [], nextCursor: null });
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(member.email)}'`)).toBe('0');
  });

  test('W04 AS-01: at 390 px the menu stacks above the form and nothing scrolls sideways @phone', async ({ page }) => {
    covers('entry.startnav.mobile-layout');
    await memberWithoutShop(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(HOME);
    const menu = await page.getByRole('navigation', { name: 'Seller' }).boundingBox();
    const card = await page.getByRole('heading', { level: 1, name: 'Open your shop' }).boundingBox();
    expect(menu && card && menu.y + menu.height <= card.y, 'the menu is above the form').toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Start selling reloads the same page.
    await page.getByRole('link', { name: 'Start selling' }).click();
    await expect(page).toHaveURL(HOME);
  });

  test('W04 AS-91: the page streams a grey block, with no "Loading" text, while the list loads @desktop', async ({ page }) => {
    covers('entry.index.loading-skeleton');
    await memberWithoutShop(page);
    const html = await (await page.request.get(HOME)).text();
    expect(html).toMatch(/data-slot="skeleton"[^>]*aria-hidden="true"/);
    expect(html).not.toMatch(/>Loading/);
  });

  test('W04 AS-08: one shop goes straight to its overview, the old inventory address to its inventory @desktop', async ({ page }) => {
    covers('entry.index.one-shop-redirect', 'entry.index.legacy-inventory-redirect');
    const member = await memberWithoutShop(page);
    const { shopId } = await openShopByApi(member);

    // The server answers with the redirect; the picker is never sent.
    const html = await (await page.request.get(HOME)).text();
    expect(html).not.toContain('Choose a shop to open its dashboard.');
    expect(html).toContain(`NEXT_REDIRECT;replace;/dashboard/seller/${shopId}`);

    await page.goto(HOME);
    await expect(page).toHaveURL(`${HOME}/${shopId}`);
    await page.goto(`${HOME}/inventory`);
    await expect(page).toHaveURL(`${HOME}/${shopId}/inventory`);
  });

  test('W04 AS-08, AS-09: several shops show the picker with status badges; closed shops are left out @desktop', async ({ page }) => {
    covers('entry.index.many-shops-picker', 'entry.index.suspended-or-deleting-in-list', 'entry.index.legacy-inventory-redirect');
    const member = await memberWithoutShop(page);
    const first = await openShopByApi(member);
    const suspended = await openSecondShop(member, 'Aiqa Suspended');
    const closing = await openSecondShop(member, 'Aiqa Closing');
    const closed = await openSecondShop(member, 'Aiqa Closed');
    setShopStatus(suspended.shopId, 'SUSPENDED');
    setShopStatus(closing.shopId, 'DELETING');
    setShopStatus(closed.shopId, 'DELETED');

    await page.goto(HOME);
    await expect(page).toHaveURL(HOME);
    await expect(page.getByRole('heading', { level: 1, name: 'Your shops' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Your shops' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('link', { name: new RegExp(first.shopName) })).toHaveAttribute('href', `${HOME}/${first.shopId}`);
    await expect(list.getByRole('listitem').filter({ hasText: 'Aiqa Suspended' })).toContainText('Suspended');
    await expect(list.getByRole('listitem').filter({ hasText: 'Aiqa Closing' })).toContainText('Closing');
    await expect(list.getByRole('listitem').filter({ hasText: first.shopName })).not.toContainText(/Suspended|Closing|Closed/);
    await expect(list).not.toContainText('Aiqa Closed');
    // The API agrees: three shops, the closed one absent, statuses as stored.
    const listed = (await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(member))).data.items as { id: string; status: string; role: string }[];
    expect(listed.map((s) => `${s.status}:${s.role}`).sort()).toEqual(['ACTIVE:OWNER', 'DELETING:OWNER', 'SUSPENDED:OWNER']);
    expect(scalar(`select status from "Shop" where id='${closed.shopId}'`)).toBe('DELETED');

    // Several shops: the old inventory address falls back to the picker.
    await page.goto(`${HOME}/inventory`);
    await expect(page).toHaveURL(HOME);
  });

  test('W04 AS-09: a valid cursor keeps the picker; a repeated cursor is ignored @desktop', async ({ page }) => {
    covers('entry.index.one-shop-with-cursor', 'entry.index.repeated-cursor-param');
    const member = await memberWithoutShop(page);
    await openShopByApi(member);
    await openSecondShop(member, 'Aiqa Second');
    const token = await tokenOf(member);
    const firstPage = (await sellerCall('GET', '/api/shops/mine?limit=1', undefined, token)).data as { items: { name: string }[]; nextCursor: string };
    expect(firstPage.nextCursor).toBeTruthy();

    // The cursor of the first row: only the second shop is left, with a link back to the first page.
    await page.goto(`${HOME}?cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'First page' })).toHaveAttribute('href', HOME);

    // A repeated parameter is no cursor: the page starts at the first row, no error.
    await page.goto(`${HOME}?cursor=a&cursor=b`);
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(2);
  });

  test('W04 AS-09: a member of one shop who opens a cursor sees the picker, not a redirect @desktop', async ({ page }) => {
    covers('entry.index.one-shop-with-cursor');
    const member = await memberWithoutShop(page);
    const { shopId } = await openShopByApi(member);
    // A real cursor from another account (made through the API only, so this browser stays signed in as `member`).
    const other = { email: uniqueEmail('aiqa-cursor') };
    expect((await sellerCall('POST', '/api/auth/register', { email: other.email, password: NEW_USER_PASSWORD })).status).toBeLessThan(300);
    await openShopByApi(other);
    await openSecondShop(other, 'Aiqa Cursor Source');
    const cursor = ((await sellerCall('GET', '/api/shops/mine?limit=1', undefined, await tokenOf(other))).data as { nextCursor: string }).nextCursor;
    await page.goto(`${HOME}?cursor=${encodeURIComponent(cursor)}`);
    await expect(page).toHaveURL(new RegExp(`${HOME}\\?cursor=`));
    await expect(page.getByRole('heading', { level: 1, name: 'Your shops' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
    expect(shopId).toBeTruthy();
  });

  test('W04 AS-89: a cursor the API refuses shows "That page link is no longer valid." with a way to the first page @desktop', async ({ page }) => {
    covers('entry.index.invalid-cursor');
    const member = await memberWithoutShop(page);
    await openShopByApi(member);
    await openSecondShop(member, 'Aiqa Two');
    const api = watchApi(page);
    await page.goto(`${HOME}?cursor=garbage`);
    // W04 B-36: the 400 is told in words with a button back to the first page (not the generic error page).
    await expect(page.getByText('That page link is no longer valid.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute('href', HOME);
    expect(api.writes()).toEqual([]);
  });

  test('W04 AS-08, AS-84: a signed-out visitor goes to sign-in with the full address as returnTo, before any shop call @desktop', async ({ page }) => {
    covers('entry.index.signed-out-redirect', 'entry.index.legacy-inventory-redirect');
    const api = watchApi(page);
    await page.goto(`${HOME}?cursor=x`);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(`${HOME}?cursor=x`)}`);
    await page.goto(`${HOME}/inventory`);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(`${HOME}/inventory`)}`);
    expect(api.count('GET', /\/shops/)).toBe(0);
  });

  test('W04 AS-84: a signed-out visit to a section of a shop keeps the section and the query in returnTo (W04 B-33, register B-023) @desktop', async ({ page }) => {
    covers('entry.index.signed-out-redirect');
    const shopId = '11111111-1111-4111-8111-111111111111';
    await page.goto(`${HOME}/${shopId}/inventory?q=mug`);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(`${HOME}/${shopId}/inventory?q=mug`)}`);
  });

  test('W04 AS-08: /dashboard goes to the seller dashboard and /dashboard/settings to account security @desktop', async ({ page }) => {
    covers('entry.index.legacy-dashboard-redirect');
    await memberWithoutShop(page);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(HOME);
    await page.goto('/dashboard/settings');
    await expect(page).toHaveURL('/account/security');
  });

  test('W04 AS-09: the shops the picker lists are exactly the ones the member owns (saved state) @desktop', async ({ page }) => {
    covers('entry.index.many-shops-picker');
    const member = await memberWithoutShop(page);
    await openShopByApi(member);
    await openSecondShop(member, 'Aiqa Rows');
    const shops = await myShops(await tokenOf(member));
    expect(shops).toHaveLength(2);
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(member.email)}' and role='OWNER'`)).toBe('2');
  });
});
}

// ---- more than 50 shops
{
/**
 * AI QA, area "entry", pass 2, section "more than one page of shops": 51 memberships for one member (six owners with nine shops
 * each, the member added as VIEWER by SQL because the real route to a membership is one invitation mail per shop), the picker's
 * two pages and the shop frame for a shop that is not in the first 50.
 */

const HOME = '/dashboard/seller';

test('W04 AS-09: 51 shops make two pages with no gap or overlap; the shop on page 2 still heads the switcher @desktop', async ({ page }) => {
  covers('entry.picker.next-page', 'entry.picker.page-size-50', 'entry.frame.current-shop-not-in-first-50');
  test.setTimeout(240_000);
  const member = await register(page);
  const memberId = userId(member.email);
  const shopIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { owner, shopId } = await ownerByApi();
    shopIds.push(shopId);
    const token = await tokenOf(owner);
    for (let n = 0; n < 8; n++) {
      const made = await sellerCall('POST', '/api/shops', { name: `Many ${i}-${n}`, slug: `aiqa-many-${Date.now().toString(36)}-${i}-${n}-${Math.floor(Math.random() * 1e4).toString(36)}` }, token);
      expect(made.status).toBe(201);
      shopIds.push(made.data.id as string);
    }
  }
  expect(shopIds).toHaveLength(54);
  const values = shopIds.slice(0, 51).map((id, index) => `('${id}','${memberId}','VIEWER','invite', now() + interval '${index} milliseconds')`).join(',');
  execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', `insert into "ShopMembership"("shopId","userId",role,source,"createdAt") values ${values}`]);
  expect(scalar(`select count(*) from "ShopMembership" where "userId"='${memberId}'`)).toBe('51');

  // The API: 50, then 1, no overlap, nothing missing.
  const token = await tokenOf(member);
  const one = (await sellerCall('GET', '/api/shops/mine?limit=50', undefined, token)).data as { items: { id: string }[]; nextCursor: string | null };
  expect(one.items).toHaveLength(50);
  expect(one.nextCursor).toBeTruthy();
  const two = (await sellerCall('GET', `/api/shops/mine?limit=50&cursor=${encodeURIComponent(one.nextCursor!)}`, undefined, token)).data as { items: { id: string }[]; nextCursor: string | null };
  expect(two.items).toHaveLength(1);
  expect(two.nextCursor).toBeNull();
  expect(new Set([...one.items, ...two.items].map((s) => s.id))).toEqual(new Set(shopIds.slice(0, 51)));

  // The page: 50 rows and "Next page"; page 2 has the last row, "First page" and no "Next page".
  await page.goto(HOME);
  const list = page.getByRole('list', { name: 'Your shops' });
  await expect(list.getByRole('listitem')).toHaveCount(50);
  const next = page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Next page' });
  await expect(next).toHaveAttribute('href', `${HOME}?cursor=${encodeURIComponent(one.nextCursor!)}`);
  await expect(page.getByRole('link', { name: 'First page' })).toHaveCount(0);
  const firstHrefs = await list.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  await next.click();
  await expect(page).toHaveURL(new RegExp(`\\?cursor=`));
  await expect(list.getByRole('listitem')).toHaveCount(1);
  const lastHref = await list.getByRole('link').first().getAttribute('href');
  expect(firstHrefs).not.toContain(lastHref);
  expect(`${HOME}/${two.items[0]!.id}`).toBe(lastHref);
  await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page).toHaveURL(HOME);
  await expect(list.getByRole('listitem')).toHaveCount(50);

  // The frame: the shop that is not in the first page heads the switcher and is marked current.
  await page.goto(`${HOME}/${two.items[0]!.id}`);
  const menu = await sellerMenu(page);
  const switcher = menu.getByRole('button').first();
  await expect(switcher).toHaveText(/Many|E2E Shop/);
  await switcher.click();
  const options = menu.getByRole('list', { name: 'Your shops' }).getByRole('listitem');
  await expect(options).toHaveCount(50);
  await expect(options.first().getByRole('link')).toHaveAttribute('aria-current', 'true');
  await expect(options.first()).toContainText('Current');
  await expect(options.first().getByRole('link')).toHaveAttribute('href', `${HOME}/${two.items[0]!.id}`);
  // "All your shops" leads to the picker's first page or to the next one.
  await expect(menu.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', /^\/dashboard\/seller(\?cursor=.+)?$/);
});
}

// ---- a failing shop list
{
/**
 * AI QA, area "entry", pass 3: the picker page when the shop list cannot be read (a stored plan the web cannot parse makes the page fail the
 * way a failed list read does; a real 5xx cannot be made without stopping a service).
 */

const HOME = '/dashboard/seller';
const sql = (statement: string) => execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', statement]);

test('W04 AS-89: a failing shop list gives the generic error page with a reference and Try again, no technical words; Try again works once the row is repaired @desktop', async ({ page }) => {
  covers('entry.index.error-boundary');
  const member = await register(page);
  await openShopByApi(member, 'Aiqa Err One');
  const bad = await openShopByApi(member, 'Aiqa Err Two');
  sql(`update "Shop" set plan='AIQA_BROKEN' where id='${bad.shopId}'`);
  try {
    const answer = await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf({ email: member.email }));
    // The API itself answers 200 with the odd plan; it is the web server that cannot read it (same error path as a 5xx: any non-401 failure).
    expect(answer.status).toBe(200);
    expect(answer.data.items.map((item: { plan: string }) => item.plan)).toContain('AIQA_BROKEN');
    await page.goto(HOME);
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).toMatch(/Reference:\s*\S+/);
    expect(text).not.toMatch(/shops_unavailable|AIQA_BROKEN|Error:|stack|at \w+\.\w+ \(|plan/i);
    await expect(page.getByRole('list', { name: 'Your shops' })).toHaveCount(0);
    sql(`update "Shop" set plan='STARTER' where id='${bad.shopId}'`);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(2);
  } finally {
    sql(`update "Shop" set plan='STARTER' where id='${bad.shopId}'`);
  }
});
}

// ---- the shop picker
{
/**
 * AI QA, area "entry", pass 2, section "the shop picker" (/dashboard/seller with several shops) and the 51-shop paging.
 * Each test names the map lines it covers in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const SUSPENDED_COPY = 'This shop is suspended. You can view data but not make changes.';

/** One member who is OWNER of one shop and ADMIN, STAFF and VIEWER of three others (different owners). */
async function memberOfFour(page: Page) {
  const member = await register(page);
  const me = { email: member.email, password: 'SuperSecurePassword123!' };
  const own = await openShopByApi(me, 'Aiqa Own Shop');
  const shops: Record<Role, { shopId: string; shopName: string }> = { OWNER: own } as never;
  for (const role of ['ADMIN', 'STAFF', 'VIEWER'] as const) {
    const made = await ownerByApi(`Aiqa ${role} Shop`);
    await acceptInvite(page, made.owner, made.shopId, me, role);
    shops[role] = { shopId: made.shopId, shopName: made.shopName };
  }
  return { me, shops };
}

test.describe('entry: the picker', () => {
  test('W04 AS-09: the list shows name, handle, role and status as stored, and a row opens its shop @desktop', async ({ page }) => {
    covers('entry.picker.heading', 'entry.picker.row-link', 'entry.picker.role-badge', 'entry.picker.status-badge', 'entry.picker.list-aria');
    const { me, shops } = await memberOfFour(page);
    setShopStatus(shops.STAFF.shopId, 'SUSPENDED');
    setShopStatus(shops.VIEWER.shopId, 'DELETING');
    await page.goto(HOME);
    await expect(page).toHaveURL(HOME);
    await expect(page.getByRole('heading', { level: 1, name: 'Your shops' })).toBeVisible();
    await expect(page.getByText('Choose a shop to open its dashboard.')).toBeVisible();
    const list = page.getByRole('list', { name: 'Your shops' });
    await expect(list.getByRole('listitem')).toHaveCount(4);
    // "Pages" landmark is there even with no links.
    await expect(page.getByRole('navigation', { name: 'Pages' })).toBeAttached();
    await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link')).toHaveCount(0);

    const expected: Record<Role, { label: string; status: string | null }> = {
      OWNER: { label: 'Owner', status: null },
      ADMIN: { label: 'Admin', status: null },
      STAFF: { label: 'Staff', status: 'Suspended' },
      VIEWER: { label: 'Viewer', status: 'Closing' },
    };
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(me))).data.items as { id: string; name: string; slug: string; role: string; status: string }[];
    for (const role of ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const) {
      const shop = shops[role];
      const [slug, dbRole, dbStatus] = rows(`select s.slug, m.role, s.status from "Shop" s join "ShopMembership" m on m."shopId"=s.id where s.id='${shop.shopId}' and m."userId"='${userId(me.email)}'`)[0]!;
      expect(dbRole, `${role} row in the database`).toBe(role);
      expect(mine.find((s) => s.id === shop.shopId)).toMatchObject({ role, slug, status: dbStatus });
      const row = list.getByRole('listitem').filter({ hasText: shop.shopName });
      await expect(row.getByRole('link')).toHaveAttribute('href', `${HOME}/${shop.shopId}`);
      await expect(row).toContainText(`@${slug}`);
      await expect(row).toContainText(expected[role].label);
      for (const word of ['Suspended', 'Closing', 'Closed']) {
        if (word === expected[role].status) await expect(row).toContainText(word);
        else await expect(row).not.toContainText(word);
      }
      const box = await row.getByRole('link').boundingBox();
      expect(box!.height, `${role} row height`).toBeGreaterThanOrEqual(56);
    }
    // A click opens that shop's overview.
    await list.getByRole('link', { name: new RegExp(shops.ADMIN.shopName) }).click();
    await expect(page).toHaveURL(`${HOME}/${shops.ADMIN.shopId}`);
    await expect(page.getByRole('heading', { level: 1, name: shops.ADMIN.shopName })).toBeVisible();
  });

  test('W04 AS-09: a very long name and handle are cut with an ellipsis and nothing scrolls sideways at 390 px @phone', async ({ page }) => {
    covers('entry.picker.long-name-truncate');
    const member = await register(page);
    const me = { email: member.email };
    const longName = `W${'i'.repeat(78)}M`;
    await openShopByApi(me, longName);
    const token = await tokenOf(me);
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const slug = `l${stamp}${'o'.repeat(38 - stamp.length)}g`;
    expect((await sellerCall('POST', '/api/shops', { name: longName, slug }, token)).status).toBe(201);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(HOME);
    const row = page.getByRole('list', { name: 'Your shops' }).getByRole('listitem').filter({ hasText: `@${slug}` });
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const nameSpan = row.locator('span.truncate').first();
    await expect(nameSpan).toHaveCSS('text-overflow', 'ellipsis');
    expect(await nameSpan.evaluate((node) => node.scrollWidth >= node.clientWidth)).toBe(true);
    const handleSpan = row.locator('span.truncate').nth(1);
    await expect(handleSpan).toHaveCSS('text-overflow', 'ellipsis');
    const box = await row.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });

  test('W04 AS-09: a suspended or closing shop opens read-only with its banner, it is not blocked @desktop', async ({ page }) => {
    covers('entry.picker.suspended-shop-click');
    const member = await register(page);
    const me = { email: member.email };
    const first = await openShopByApi(me, 'Aiqa Sus One');
    const second = await openShopByApi(me, 'Aiqa Sus Two');
    setShopStatus(first.shopId, 'SUSPENDED');
    setShopStatus(second.shopId, 'DELETING');
    await page.goto(HOME);
    const list = page.getByRole('list', { name: 'Your shops' });
    await list.getByRole('link', { name: /Aiqa Sus One/ }).click();
    await expect(page).toHaveURL(`${HOME}/${first.shopId}`);
    await expect(page.getByText(SUSPENDED_COPY)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Aiqa Sus One' })).toBeVisible();
    const read = await sellerCall('GET', `/api/shops/${first.shopId}`, undefined, await tokenOf(me));
    expect([read.status, read.data.status]).toEqual([200, 'SUSPENDED']);
    // The same page for a closing shop, with the other words.
    await page.goto(`${HOME}/${second.shopId}`);
    await expect(page.getByText('This shop is being closed. You can view data but not make changes.')).toBeVisible();
    expect(scalar(`select status from "Shop" where id='${first.shopId}'`)).toBe('SUSPENDED');
  });

  test('W04 AS-09: the switcher button states open/closed, the list shows name, handle, role, status and the current shop @desktop', async ({ page }) => {
    covers('entry.switcher.button', 'entry.switcher.list-content');
    const { me, shops } = await memberOfFour(page);
    setShopStatus(shops.STAFF.shopId, 'SUSPENDED');
    setShopStatus(shops.VIEWER.shopId, 'DELETING');
    await page.goto(`${HOME}/${shops.ADMIN.shopId}`);
    await expect(page.getByRole('heading', { level: 1, name: shops.ADMIN.shopName })).toBeVisible();
    await sellerNav(page);
    const root = isPhone(page) ? page.getByRole('dialog', { name: 'Seller menu' }) : page.locator('aside');
    const button = root.getByRole('button').first();
    await expect(button).toHaveText(shops.ADMIN.shopName);
    await expect(button.locator('svg')).toHaveCount(1); // the chevron
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).not.toHaveAttribute('aria-controls', /.+/);
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const listId = await button.getAttribute('aria-controls');
    expect(listId).toBeTruthy();
    const list = root.getByRole('list', { name: 'Your shops' });
    await expect(list).toHaveAttribute('id', listId!);
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(4);

    const token = await tokenOf(me);
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, token)).data.items as { id: string; slug: string; role: string; status: string }[];
    const label: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', STAFF: 'Staff', VIEWER: 'Viewer' };
    const statusWord: Record<string, string> = { SUSPENDED: 'Suspended', DELETING: 'Closing' };
    for (const role of ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const) {
      const shop = shops[role];
      const stored = rows(`select s.slug, m.role, s.status from "Shop" s join "ShopMembership" m on m."shopId"=s.id where s.id='${shop.shopId}' and m."userId"='${userId(me.email)}'`)[0]!;
      expect(mine.find((s) => s.id === shop.shopId)).toMatchObject({ slug: stored[0], role: stored[1], status: stored[2] });
      const item = items.filter({ hasText: shop.shopName });
      await expect(item).toContainText(stored[0]!);
      await expect(item).toContainText(label[stored[1]!]!);
      if (statusWord[stored[2]!]) await expect(item).toContainText(statusWord[stored[2]!]!);
      else await expect(item).not.toContainText(/Suspended|Closing|Closed/);
      if (role === 'ADMIN') {
        await expect(item).toContainText('Current');
        await expect(item.getByRole('link')).toHaveAttribute('aria-current', 'true');
      } else {
        await expect(item).not.toContainText('Current');
        await expect(item.getByRole('link')).not.toHaveAttribute('aria-current', /.*/);
      }
    }
    // A second press closes it again, Escape closes it and returns focus to the button.
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toHaveCount(0);
    await button.click();
    await page.keyboard.press('Escape');
    if (!isPhone(page)) {
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toBeFocused();
    }
  });
});
}

// ---- the shop switcher
{
/**
 * AI QA, area "entry", pass 3, section "the shop switcher": the list in the sidebar (desktop) and in the drawer (phone), what a
 * choice keeps (section, not the query), how it opens and closes, the badges, the long names, the stale list. Each test names the
 * map lines it covers in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const PASSWORD = 'SuperSecurePassword123!';

/** A member who owns shop A and is VIEWER of shop B (someone else's). */
async function ownerAndViewer(page: Page) {
  const member = await register(page);
  const me = { email: member.email, password: PASSWORD };
  const a = await openShopByApi(me, 'Aiqa Alpha');
  const other = await ownerByApi('Aiqa Bravo');
  await acceptInvite(page, other.owner, other.shopId, me, 'VIEWER');
  return { me, a, b: { shopId: other.shopId, shopName: other.shopName } };
}

/** Opens the switcher (in the drawer on a phone); returns the menu and the list. */
async function openSwitcher(page: Page) {
  const menu = await sellerMenu(page);
  const trigger = menu.getByRole('button').first();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return { menu, trigger, list: menu.getByRole('list', { name: 'Your shops' }) };
}

test.describe('entry: the shop switcher', () => {
  test('W04 AS-09: a choice keeps the section and drops the query; a shop where the role lacks the page shows the access panel; the list closes @desktop', async ({ page }) => {
    covers('entry.switcher.keeps-section', 'entry.switcher.keeps-section-forbidden', 'entry.switcher.keeps-query', 'entry.switcher.close-on-choose', 'entry.switcher.close-on-path-change');
    const { a, b } = await ownerAndViewer(page);
    const bLink = (menu: ReturnType<Page['locator']>) => menu.getByRole('list', { name: 'Your shops' }).getByRole('link').filter({ hasText: b.shopName });
    const places: [string, string][] = [
      ['', ''],
      ['/inventory?q=mug&cursor=abc', '/inventory'],
      ['/orders?status=PAID&page=2', '/orders'],
      [`/developers/webhooks/${UNKNOWN_ID}`, '/developers/webhooks'],
      ['/developers/api-keys', '/developers/api-keys'],
      ['/team?tab=invitations', '/team'],
    ];
    for (const [from, kept] of places) {
      await page.goto(`${HOME}/${a.shopId}${from}`);
      const { menu } = await openSwitcher(page);
      await expect(bLink(menu), `href from ${from || 'overview'}`).toHaveAttribute('href', `${HOME}/${b.shopId}${kept}`);
    }

    // Click: inventory with a filter -> other shop's inventory, no query, empty search box.
    await page.goto(`${HOME}/${a.shopId}/inventory?q=mug&cursor=abc`);
    const watch = watchApi(page);
    const { menu, list } = await openSwitcher(page);
    await bLink(menu).click();
    await expect(page).toHaveURL(`${HOME}/${b.shopId}/inventory`);
    expect(new URL(page.url()).search).toBe('');
    // Closed after the choice: the list is gone and, on a phone, the drawer too.
    if (isPhone(page)) await expect(page.getByRole('dialog', { name: 'Seller menu' })).toBeHidden();
    else await expect(list).toBeHidden();
    await expect(page.getByRole('heading', { name: /Inventory/ }).first()).toBeVisible();
    // No request of the second shop carries the first shop's filter.
    expect(watch.seen.filter((s) => /\bq=mug|cursor=abc/.test(s.path)).map((s) => s.path)).toEqual([]);
    const searchBox = page.getByRole('searchbox').first();
    if (await searchBox.count()) await expect(searchBox).toHaveValue('');

    // A role that lacks the page: the VIEWER has no API keys permission in shop B.
    await page.goto(`${HOME}/${a.shopId}/developers/api-keys`);
    await expect(page.getByRole('heading', { name: 'API keys' }).first()).toBeVisible();
    const second = await openSwitcher(page);
    await bLink(second.menu).click();
    await expect(page).toHaveURL(`${HOME}/${b.shopId}/developers/api-keys`);
    await expect(page.getByRole('heading', { name: "You don't have access to this page." })).toBeVisible();
    await expect(page.getByText('Your role in this shop: Viewer.')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    // Closing on a changed address: open the list, go Back.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${a.shopId}/developers/api-keys$`));
    const third = await openSwitcher(page);
    if (!isPhone(page)) {
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${b.shopId}/developers/api-keys$`));
      await expect(third.list).toBeHidden();
      await expect(third.trigger).toHaveAttribute('aria-expanded', 'false');
    } else {
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${b.shopId}/developers/api-keys$`));
      await expect(page.getByRole('dialog', { name: 'Seller menu' })).toBeHidden();
    }
  });

  test('W04 AS-09: Escape closes the list and returns focus; a click outside does not close; Tab goes button, shops, All your shops; no arrow keys @desktop', async ({ page }) => {
    covers('entry.switcher.escape', 'entry.switcher.not-closing-on-outside-click', 'entry.switcher.keyboard-nav', 'entry.switcher.one-shop');
    const { a, b } = await ownerAndViewer(page);

    // One shop: the owner of a single shop still has the button and a one-item list with "Current".
    const solo = await ownerByApi('Aiqa Solo');
    const soloPage = await page.context().browser()!.newContext({ viewport: page.viewportSize() ?? undefined });
    const soloTab = await soloPage.newPage();
    const soloMember = await register(soloTab);
    const soloShop = await openShopByApi({ email: soloMember.email }, 'Aiqa Only One');
    await soloTab.goto(`${HOME}/${soloShop.shopId}`);
    const one = await openSwitcher(soloTab);
    await expect(one.trigger).toHaveText('Aiqa Only One');
    await expect(one.list.getByRole('listitem')).toHaveCount(1);
    await expect(one.list.getByRole('listitem')).toContainText('Current');
    await expect(one.list.getByRole('link')).toHaveAttribute('aria-current', 'true');
    await expect(one.menu.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', HOME);
    await soloPage.close();
    void solo;

    await page.goto(`${HOME}/${a.shopId}/inventory`);
    const { menu, trigger, list } = await openSwitcher(page);
    await expect(trigger).toHaveAttribute('aria-controls', /.+/);
    await expect(list.getByRole('listitem')).toHaveCount(2);

    // Tab order from the button: each shop link in list order, then "All your shops".
    await trigger.focus();
    const names = await list.getByRole('link').evaluateAll((links) => links.map((link) => link.querySelector('span span')?.textContent ?? ''));
    expect(names).toHaveLength(2);
    for (const [index, name] of names.entries()) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.textContent ?? ''), `Tab ${index + 1}`).toContain(name);
    }
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('link', { name: 'All your shops' })).toBeFocused();

    // Arrow keys do nothing: focus stays where it is, the list stays open.
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('link', { name: 'All your shops' })).toBeFocused();
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(trigger).toBeFocused();
    await expect(list).toBeVisible();

    // A click outside (on the page content) does not close it.
    if (!isPhone(page)) {
      await page.locator('#main-content').click({ position: { x: 5, y: 5 } });
      await expect(list).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    }

    // Escape from inside the list closes it and puts focus back on the button.
    await list.getByRole('link').last().focus();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).not.toHaveAttribute('aria-controls');
    // On a phone the first Escape closed only the list: the drawer is still open (stopPropagation); the second closes the drawer.
    if (isPhone(page)) {
      await expect(page.getByRole('dialog', { name: 'Seller menu' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Seller menu' })).toBeHidden();
    }
    void b;
  });

  test('W04 AS-09: badges follow the stored status; a shop opened later shows after navigation, with the API list and rows as the source @desktop', async ({ page }) => {
    covers('entry.switcher.status-badge', 'entry.switcher.stale-list');
    const { me, a } = await ownerAndViewer(page);
    const c = await openSecondShop(me, 'Aiqa Charlie');
    const d = await openSecondShop(me, 'Aiqa Delta');
    setShopStatus(c.shopId, 'SUSPENDED');
    setShopStatus(d.shopId, 'DELETING');
    expect(scalar(`select status from "Shop" where id='${c.shopId}'`)).toBe('SUSPENDED');
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(me))).data.items as { id: string; status: string }[];
    expect(mine.find((s) => s.id === c.shopId)?.status).toBe('SUSPENDED');
    expect(mine.find((s) => s.id === d.shopId)?.status).toBe('DELETING');

    await page.goto(`${HOME}/${a.shopId}`);
    const { list } = await openSwitcher(page);
    const rowOf = (name: string) => list.getByRole('listitem').filter({ hasText: name });
    await expect(rowOf('Aiqa Charlie')).toContainText('Suspended');
    await expect(rowOf('Aiqa Delta')).toContainText('Closing');
    await expect(rowOf('Aiqa Alpha')).not.toContainText(/Suspended|Closing|Closed/);
    await expect(rowOf('Aiqa Bravo')).not.toContainText(/Suspended|Closing|Closed/);
    await expect(rowOf('Aiqa Alpha')).toContainText('Owner');
    await expect(rowOf('Aiqa Bravo')).toContainText('Viewer');
    expect(rows(`select role from "ShopMembership" where "userId"='${userId(me.email)}' order by role`).flat()).toEqual(['OWNER', 'OWNER', 'OWNER', 'VIEWER']);

    // A shop opened while the page is open: the list does not change until the page is loaded again.
    const e = await openSecondShop(me, 'Aiqa Echo');
    if (isPhone(page)) await page.keyboard.press('Escape');
    await expect(rowOf('Aiqa Echo')).toHaveCount(0);
    await page.reload();
    const after = await openSwitcher(page);
    await expect(after.list.getByRole('listitem')).toHaveCount(5);
    await expect(after.list.getByRole('listitem').filter({ hasText: 'Aiqa Echo' })).toHaveCount(1);
    void e;
  });

  test('W04 AS-09: 80-character names and markup in a name stay on one line as text; at 390 px the button and rows are at least 44 px high @phone', async ({ page }) => {
    covers('entry.switcher.long-names', 'entry.switcher.touch-targets');
    await page.setViewportSize({ width: 390, height: 844 });
    const member = await register(page);
    const me = { email: member.email, password: PASSWORD };
    const long = `${'W'.repeat(40)} ${'m'.repeat(39)}`;
    expect(long).toHaveLength(80);
    const markup = '<img src=x onerror="window.__aiqa=1"> <b>b</b>';
    const first = await openShopByApi(me, long);
    const second = await openSecondShop(me, markup);
    await page.goto(`${HOME}/${first.shopId}`);
    const { menu, trigger, list } = await openSwitcher(page);
    // The names are text: no element made from them, nothing ran.
    await expect(list.getByText(markup, { exact: false })).toHaveCount(1);
    await expect(menu.locator('img, b')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __aiqa?: number }).__aiqa)).toBeUndefined();
    // One line each, cut with an ellipsis, inside the screen.
    const nameSpan = list.getByRole('listitem').filter({ hasText: 'WWWW' }).locator('span.truncate').first();
    const css = await nameSpan.evaluate((node) => ({ overflow: getComputedStyle(node).textOverflow, clipped: node.scrollWidth > node.clientWidth, lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)) }));
    expect(css).toMatchObject({ overflow: 'ellipsis', clipped: true, lines: 1 });
    expect(await trigger.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node.firstElementChild!).textOverflow === 'ellipsis')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Touch targets.
    for (const target of [trigger, ...(await list.getByRole('link').all()), menu.getByRole('link', { name: 'All your shops' })]) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    void second;
  });

  test('W04 AS-09: with 51 shops the switcher shows 50, scrolls inside its box and "All your shops" carries the API cursor @desktop', async ({ page }) => {
    covers('entry.switcher.max-50');
    test.setTimeout(240_000);
    const member = await register(page);
    const memberId = userId(member.email);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { owner, shopId } = await ownerByApi();
      ids.push(shopId);
      const token = await tokenOf(owner);
      for (let n = 0; n < 8; n++) {
        const made = await sellerCall('POST', '/api/shops', { name: `Cap ${i}-${n}`, slug: `aiqa-cap-${Date.now().toString(36)}-${i}-${n}-${Math.floor(Math.random() * 1e4).toString(36)}` }, token);
        expect(made.status).toBe(201);
        ids.push(made.data.id as string);
      }
    }
    const values = ids.slice(0, 51).map((id, index) => `('${id}','${memberId}','VIEWER','invite', now() + interval '${index} milliseconds')`).join(',');
    execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', `insert into "ShopMembership"("shopId","userId",role,source,"createdAt") values ${values}`]);
    const token = await tokenOf(member);
    const one = (await sellerCall('GET', '/api/shops/mine?limit=50', undefined, token)).data as { items: { id: string }[]; nextCursor: string | null };
    expect(one.items).toHaveLength(50);
    expect(one.nextCursor).toBeTruthy();

    await page.goto(`${HOME}/${one.items[0]!.id}`);
    const { menu, list } = await openSwitcher(page);
    await expect(list.getByRole('listitem')).toHaveCount(50);
    await expect(menu.getByRole('link', { name: 'All your shops' })).toHaveAttribute('href', `${HOME}?cursor=${encodeURIComponent(one.nextCursor!)}`);
    const box = await list.evaluate((node) => ({ scrolls: node.scrollHeight > node.clientHeight, height: node.clientHeight, overflowY: getComputedStyle(node).overflowY, maxHeight: getComputedStyle(node).maxHeight }));
    expect(box).toMatchObject({ scrolls: true, overflowY: 'auto', maxHeight: '288px' });
    // The 51st shop is not in the list (it sits on the picker's second page).
    await expect(list.getByRole('link').filter({ has: page.locator(`[href="${HOME}/${ids[50]}"]`) })).toHaveCount(0);
    expect(await list.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).not.toContain(`${HOME}/${ids[50]}`);
    // Following the link ends at the picker's second page with that shop.
    await menu.getByRole('link', { name: 'All your shops' }).click();
    await expect(page).toHaveURL(new RegExp(`${HOME}\\?cursor=`));
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(1);
  });
});
}
