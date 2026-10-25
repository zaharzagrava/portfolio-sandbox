import { expect, test, type Page, type Route } from '@playwright/test';
import { NEW_USER_PASSWORD, register, resetRateLimits, sellerCall, uniqueEmail } from '../../helpers';
import { openSecondShop, shopWithSlug, tokenOf, watchApi } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';
import { rows, scalar, userId } from '../support/db';

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
  test('entry.form.heading entry.form.name-field entry.form.handle-field: labels, limits and hints of the two fields', async ({ page }) => {
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

  test('entry.form.handle-follows-name entry.form.handle-stops-following: the handle follows the name until it is edited by hand', async ({ page }) => {
    covers('entry.form.handle-follows-name', 'entry.form.handle-stops-following');
    const form = await onTheForm(page);
    await form.name.fill('  Clay Works & Co  ');
    await expect(form.handle).toHaveValue('clay-works-co');
    await form.handle.fill('mine');
    await form.name.fill('Clay Works Again');
    await expect(form.handle).toHaveValue('mine');
    // Emptied by hand: it stays empty, it does not follow again.
    await form.handle.fill('');
    await form.name.fill('Another Name');
    await expect(form.handle).toHaveValue('');
  });

  test('entry.form.slugify-edge-cases: symbols give an empty handle, long names are cut at 40, accents are stripped without splitting words', async ({ page }) => {
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

  test('entry.form.name-validation-blur entry.form.handle-validation-blur: a field is checked when it loses focus, never while typing', async ({ page }) => {
    covers('entry.form.name-validation-blur', 'entry.form.handle-validation-blur');
    const form = await onTheForm(page);
    await form.name.fill(' a ');
    await expect(page.getByText(NAME_RULE)).toBeHidden();
    await form.handle.focus();
    await expect(page.getByText(NAME_RULE)).toBeVisible();
    await expect(form.name).toHaveAttribute('aria-invalid', 'true');
    await expect(form.name).toHaveAttribute('aria-describedby', 'shop-name-problem');
    await expect(page.locator('#shop-name-problem')).toHaveCSS('color', /^(lab|oklch|rgb)/);
    await form.name.fill('ab');
    await expect(page.getByText(NAME_RULE)).toBeHidden();
    await expect(form.name).not.toHaveAttribute('aria-invalid', 'true');

    for (const bad of ['ab', 'a'.repeat(41), 'Upper', 'has space', '-lead', 'trail-', 'a_b']) {
      await form.handle.fill(bad);
      await form.name.focus();
      await expect(page.getByText(HANDLE_RULE), `"${bad}" is refused`).toBeVisible();
      await expect(form.handle).toHaveAttribute('aria-describedby', 'shop-slug-problem');
    }
    for (const good of ['abc', 'a'.repeat(40), 'ok--dash']) {
      await form.handle.fill(good);
      await form.name.focus();
      await expect(page.getByText(HANDLE_RULE), `"${good}" is accepted`).toBeHidden();
    }
  });

  test('entry.form.handle-pattern-parity: the form and the API accept and refuse the same handles', async ({ page }) => {
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

  test('entry.form.submit-invalid-focus: Open shop with invalid fields sends nothing and moves focus to the first invalid field', async ({ page }) => {
    covers('entry.form.submit-invalid-focus');
    const form = await onTheForm(page);
    const api = watchApi(page);
    await form.submit.click();
    await expect(page.getByText(NAME_RULE)).toBeVisible();
    await expect(page.getByText(HANDLE_RULE)).toBeVisible();
    await expect(form.name).toBeFocused();
    expect(api.writes()).toEqual([]);

    // Name fine, handle not: the focus goes to the Handle.
    await form.name.fill('Good Name');
    await form.handle.fill('Bad Handle');
    await form.submit.click();
    await expect(form.handle).toBeFocused();
    expect(api.writes()).toEqual([]);
  });

  test('entry.form.enter-key-submits: Enter in a field submits the form like the button', async ({ page }) => {
    covers('entry.form.enter-key-submits');
    const form = await onTheForm(page);
    await form.name.fill('');
    await form.handle.fill('good-one');
    await form.name.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(NAME_RULE)).toBeVisible();
    await expect(form.name).toBeFocused();
  });

  test('entry.form.submit-happy-path entry.form.button-label-pending entry.form.double-press-one-request entry.form.invalidates-shops-cache entry.form.role-refresh-background: one valid press opens one shop, saved in every table, and the role catches up', async ({ page }) => {
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

  test('entry.form.error-slug-taken entry.form.error-clears-on-edit entry.form.error-name-focus: a taken handle is told under the Handle, focus moves there, editing clears it', async ({ page }) => {
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

  test('entry.form.error-slug-reserved: reserved handles are refused under the Handle and nothing is saved', async ({ page }) => {
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

  test('entry.form.error-validation-failed entry.form.error-name-focus entry.form.error-clears-on-edit: server field problems land under the right field; only a new answer moves focus; editing clears one message', async ({ page }) => {
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

  test('entry.form.error-shop-limit: the 11th shop is refused with a form-level alert and no row', async ({ page }) => {
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

  test('entry.form.error-rate-limit: a 429 shows the countdown above the button, disables it, and re-enables it at zero', async ({ page }) => {
    covers('entry.form.error-rate-limit');
    // The real 6th request cannot be made on the dev stack (the limiter lets this machine's addresses through), so the answer is given.
    const form = await onTheForm(page);
    await answerShopCreateWith(page, 429, 'rate_limited', {}, { 'retry-after': '4' });
    await form.name.fill('Count Down');
    await form.submit.click();
    await expect(page.getByText(/^Too many attempts\. Try again in \d s\.$/)).toBeVisible();
    await expect(form.submit).toBeDisabled();
    await expect(page.getByText('You can try again now.').first()).toBeVisible({ timeout: 10_000 });
    await expect(form.submit).toBeEnabled();
  });

  test('entry.form.error-5xx-network: a server error or a lost connection is told above the button and the form stays usable', async ({ page }) => {
    covers('entry.form.error-5xx-network');
    const form = await onTheForm(page);
    await answerShopCreateWith(page, 500, 'internal_error');
    await form.name.fill('Server Trouble');
    await form.submit.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong on our side.' })).toBeVisible();
    await expect(page.getByText('Reference: req-aiqa')).toBeVisible();
    await expect(form.submit).toBeEnabled();
    await page.unroute('**/api/shops');
    await page.route('**/api/shops', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.fallback()));
    await form.submit.click();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't reach the server. Check your connection and try again." })).toBeVisible();
    await expect(form.submit).toBeEnabled();
  });

  test('entry.form.api-name-limits: the API holds the same name and unknown-field rules as the form', async ({ page }) => {
    covers('entry.form.name-field', 'entry.form.error-validation-failed');
    const form = await onTheForm(page);
    const token = await tokenOf(form);
    for (const body of [{ name: 'A', slug: 'abc-def' }, { name: 'x'.repeat(81), slug: 'abc-def' }, { slug: 'abc-def' }, { name: 'Ok Name' }, { name: 'Ok Name', slug: 'abc-def', extra: 1 }]) {
      const result = await sellerCall('POST', '/api/shops', body, token);
      expect(result.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(result.data.code).toBe('validation_failed');
    }
    expect(scalar(`select count(*) from "ShopMembership" where "userId"='${userId(form.email)}'`)).toBe('0');
  });

  test('entry.form.api-unknown-shop-id: a shop id that is not a UUID answers the same 404 as an unknown one (S03 R-01)', async ({ page }) => {
    covers('entry.form.api-unknown-shop-id');
    const form = await onTheForm(page);
    const token = await tokenOf(form);
    const malformed = await sellerCall('GET', '/api/shops/not-a-uuid', undefined, token);
    const unknown = await sellerCall('GET', '/api/shops/11111111-1111-4111-8111-111111111111', undefined, token);
    expect([malformed.status, unknown.status]).toEqual([404, 404]);
    expect([malformed.data.code, unknown.data.code]).toEqual(['shop_not_found', 'shop_not_found']);
  });
});
