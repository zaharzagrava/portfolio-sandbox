import { type Page, expect, test } from '@playwright/test';
import { API_URL, NEW_USER_PASSWORD, SEED, register, sellerCall, uniqueEmail } from './helpers';
import { UNKNOWN_ID, openSecondShop, tokenOf, watchApi } from './seller/cross-cutting/support';
import { type Role, acceptInvite, covers, isPhone, memberWithRole, ownerByApi, sellerNav } from './support/seller-entry';
import { execFileSync } from 'node:child_process';
import { openShopByApi } from './seller-setup';
import { rows, scalar, setShopStatus, userId } from './seller/support/db';

// ---- menu entries by role
{
/**
 * AI QA, area "entry", pass 2, section "menu entries by role": a real OWNER, ADMIN, STAFF and VIEWER (the last three made by the
 * real invitation mail) each look at the whole menu. Expected entries come from the permission matrix of S03 (typed here on purpose,
 * not read from the code under test). Each test names the map lines it covers in its title and in the `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const NO_ACCESS = "You don't have access to this page.";

const READ = ['shop.read', 'members.read', 'products.read', 'orders.read'];
const STAFF = [...READ, 'products.write', 'orders.manage'];
const ADMIN = [...STAFF, 'shop.manage', 'members.manage', 'payouts.read', 'api-keys.manage', 'webhooks.manage', 'integrations.manage', 'widget.manage'];
const MATRIX: Record<Role, string[]> = { VIEWER: READ, STAFF, ADMIN, OWNER: [...ADMIN, 'shop.delete', 'shop.export', 'billing.manage', 'sso.manage'] };

/** id, label, section, permission that shows it (the spec's "Screens and routes"). */
const ENTRIES: { id: string; label: string; section: string; needs: string | null }[] = [
  { id: 'overview', label: 'Overview', section: '', needs: 'shop.read' },
  { id: 'inventory', label: 'Inventory', section: '/inventory', needs: 'products.read' },
  { id: 'orders', label: 'Orders', section: '/orders', needs: 'orders.read' },
  { id: 'team', label: 'Team', section: '/team', needs: 'members.read' },
  { id: 'payouts', label: 'Payouts', section: '/payouts', needs: 'payouts.read' },
  { id: 'statements', label: 'Statements', section: '/statements', needs: 'payouts.read' },
  { id: 'imports', label: 'Import', section: '/imports', needs: 'products.write' },
  { id: 'exports', label: 'Order export', section: '/exports', needs: 'orders.manage' },
  { id: 'integrations', label: 'Integrations', section: '/integrations', needs: 'integrations.manage' },
  { id: 'campaigns', label: 'Campaigns', section: '/campaigns', needs: 'products.read' },
  { id: 'widget', label: 'Storefront widget', section: '/widget', needs: 'widget.manage' },
  { id: 'knowledge', label: 'Help documents', section: '/knowledge', needs: 'products.read' },
  { id: 'api-keys', label: 'API keys', section: '/developers/api-keys', needs: 'shop.manage' },
  { id: 'webhooks', label: 'Webhooks', section: '/developers/webhooks', needs: 'webhooks.manage' },
  { id: 'api-version', label: 'API version', section: '/developers/api-version', needs: 'shop.manage' },
  { id: 'logs', label: 'Request logs', section: '/developers/logs', needs: 'shop.read' },
  { id: 'usage', label: 'Usage', section: '/developers/usage', needs: 'shop.read' },
  { id: 'api-docs', label: 'API documentation', section: '', needs: null },
];
const DEVELOPERS = ['api-keys', 'webhooks', 'api-version', 'logs', 'usage', 'api-docs'];

for (const role of ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const) {
  test(`W04 AS-54: a ${role} sees exactly the entries the matrix gives, the others are refused by hand with the access panel @desktop`, async ({ browser }) => {
    covers(...ENTRIES.map((e) => `entry.nav.${e.id}`), 'entry.nav.group-hidden-when-empty', 'entry.nav.team-invitations-gating', 'entry.shell.nav-account-links');
    test.setTimeout(300_000);
    const { page, context, member, shopId } = await memberWithRole(browser, role);
    try {
      // The API says what the role may do (the shop answer's myPermissions); the menu has to follow it.
      const shop = (await sellerCall('GET', `/api/shops/${shopId}`, undefined, await tokenOf(member))).data as { myRole: string; myPermissions: string[] };
      expect(shop.myRole).toBe(role);
      expect([...shop.myPermissions].sort()).toEqual([...MATRIX[role]].sort());
      const dbRole = rows(`select m.role from "ShopMembership" m where m."shopId"='${shopId}' and m."userId"='${userId(member.email)}'`)[0]!;
      expect(dbRole[0]).toBe(role);

      await page.goto(`${HOME}/${shopId}`);
      const visible: string[] = [];
      const hidden: string[] = [];
      for (const entry of ENTRIES) {
        const allowed = entry.needs === null || MATRIX[role].includes(entry.needs);
        (allowed ? visible : hidden).push(entry.id);
        const link = (await sellerNav(page)).getByRole('link', { name: entry.label, exact: true });
        if (allowed) {
          await expect.soft(link, `${role}: ${entry.id} shown`).toHaveCount(1);
          const href = entry.id === 'api-docs' ? '/developers/docs' : `${HOME}/${shopId}${entry.section}`;
          await expect.soft(link, `${role}: ${entry.id} href`).toHaveAttribute('href', href);
        } else {
          await expect.soft(link, `${role}: ${entry.id} hidden`).toHaveCount(0);
        }
        if (isPhone(page)) await page.keyboard.press('Escape');
      }

      // Group headings: a group with no entries has no heading; the Developers group of a VIEWER is Request logs, Usage, API documentation.
      const nav = await sellerNav(page);
      const developers = DEVELOPERS.filter((id) => visible.includes(id));
      await expect.soft(nav.getByRole('heading', { level: 2 }), `${role}: headings`).toHaveText(['Shop', 'Developers', 'Account']);
      if (role === 'VIEWER') {
        expect.soft(developers, 'viewer Developers group').toEqual(['logs', 'usage', 'api-docs']);
        await expect.soft(nav.locator('section').filter({ has: page.getByRole('heading', { name: 'Developers' }) }).getByRole('link')).toHaveText(['Request logs', 'Usage', 'API documentation']);
      }
      // Account links for every role.
      await expect.soft(nav.getByRole('link', { name: 'Your orders' })).toHaveAttribute('href', '/orders');
      await expect.soft(nav.getByRole('link', { name: 'Account security' })).toHaveAttribute('href', '/account/security');
      if (isPhone(page)) await page.keyboard.press('Escape');

      // Entries that are not shown: the page typed by hand is the access panel, in the shell; entries that are shown open their page.
      for (const entry of ENTRIES.filter((e) => e.id !== 'api-docs')) {
        const allowed = hidden.indexOf(entry.id) < 0;
        await page.goto(`${HOME}/${shopId}${entry.section}`);
        const panel = page.getByRole('heading', { name: NO_ACCESS });
        if (allowed) await expect.soft(panel, `${role}: ${entry.id} page opens`).toHaveCount(0);
        else {
          await expect.soft(panel, `${role}: ${entry.id} refused by hand`).toBeVisible();
          await expect.soft(page.getByText(`Your role in this shop: ${role[0]}${role.slice(1).toLowerCase()}.`)).toBeVisible();
          await expect.soft(page.getByRole('link', { name: 'Overview' }).last()).toHaveAttribute('href', `${HOME}/${shopId}`);
        }
        // The page follows the menu: the entry that points here is the current one (when it is shown).
        if (allowed) {
          const current = (await sellerNav(page)).locator('[aria-current="page"]');
          await expect.soft(current, `${role}: ${entry.id} marked current`).toHaveText(entry.label);
          if (isPhone(page)) await page.keyboard.press('Escape');
        }
      }

      // The click path for one shown entry (menu -> page -> marked current).
      await page.goto(`${HOME}/${shopId}`);
      await (await sellerNav(page)).getByRole('link', { name: 'Inventory', exact: true }).click();
      await expect(page).toHaveURL(`${HOME}/${shopId}/inventory`);

      // The Invitations tab of Team needs members.manage (ADMIN and OWNER).
      await page.goto(`${HOME}/${shopId}/team?tab=invitations`);
      const canInvite = MATRIX[role].includes('members.manage');
      if (canInvite) await expect.soft(page.getByRole('heading', { name: NO_ACCESS }), `${role}: invitations open`).toHaveCount(0);
      else await expect.soft(page.getByRole('heading', { name: NO_ACCESS }), `${role}: invitations refused`).toBeVisible();
      await page.goto(`${HOME}/${shopId}/team`);
      await expect.soft(page.getByRole('heading', { name: NO_ACCESS }), `${role}: team list opens`).toHaveCount(0);
      await expect.soft(page.getByRole('tab', { name: /Invitations/ }), `${role}: Invitations tab`).toHaveCount(canInvite ? 1 : 0);
    } finally {
      await context.close();
    }
  });
}
}

// ---- roles and the shop API
{
/**
 * AI QA, area "entry", pass 3, section "the shop API and roles": what /shops* answers and writes (Shop, ShopMembership,
 * ShopDirectory, ShopStatusHistory, Outbox), and what the menu shows for real members. The permission matrix is typed here on
 * purpose (S03 FR-020), not read from the code under test. Each test names the map lines it covers in its title and in the
 * `aiqa-lines` annotation.
 */

const HOME = '/dashboard/seller';
const READ = ['shop.read', 'members.read', 'products.read', 'orders.read'];
const STAFF = [...READ, 'products.write', 'orders.manage'];
const ADMIN = [...STAFF, 'shop.manage', 'members.manage', 'payouts.read', 'api-keys.manage', 'webhooks.manage', 'integrations.manage', 'widget.manage'];
const MATRIX: Record<Role, string[]> = { VIEWER: READ, STAFF, ADMIN, OWNER: [...ADMIN, 'shop.delete', 'shop.export', 'billing.manage', 'sso.manage'] };
const slugOf = (tag: string) => `aiqa-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}`;
const sql = (statement: string) => execFileSync('docker', ['exec', '-i', process.env.AIQA_DB_CONTAINER ?? 'payment_system_db', 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', statement]);

/** Entries a role sees: the shop group by permission, developers by permission, plus API documentation. 18 entries for the owner. */
const ENTRY_COUNT: Record<Role, number> = { OWNER: 18, ADMIN: 18, STAFF: 11, VIEWER: 9 };

test.describe('entry: roles and the shop API', () => {
  test('W04 AS-54: a hidden page typed by hand is the access panel with no data request; the API says 404, 403 and 401 in order @desktop', async ({ browser }) => {
    covers('entry.rbac.hidden-page-direct-url', 'entry.rbac.forbidden-panel-button', 'entry.rbac.api-still-enforces');
    test.setTimeout(180_000);
    const { page, context, member, shopId, owner } = await memberWithRole(browser, 'VIEWER');
    const stranger = await ownerByApi();
    try {
      const watch = watchApi(page);
      for (const [section, dataPath] of [['/developers/api-keys', /api-keys/], ['/payouts', /payouts/], ['/imports', /imports/], ['/exports', /exports/], ['/developers/webhooks', /webhook/]] as const) {
        watch.reset();
        await page.goto(`${HOME}/${shopId}${section}`);
        await expect(page.getByRole('heading', { name: "You don't have access to this page." })).toBeVisible();
        await expect(page.getByText('Your role in this shop: Viewer.')).toBeVisible();
        await expect(page.getByText('Ask a shop owner or admin to change your role.')).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(watch.seen.filter((s) => dataPath.test(s.path)).map((s) => s.path), `${section}: no data request`).toEqual([]);
      }
      const overview = page.locator('#main-content').getByRole('link', { name: 'Overview' }).last();
      await expect(overview).toHaveAttribute('href', `${HOME}/${shopId}`);
      await overview.click();
      await expect(page).toHaveURL(`${HOME}/${shopId}`);

      // The API, in order: 401 (no token), 404 (not a member), 403 (member without the permission), then the status gate.
      const token = await tokenOf(member);
      const strangerToken = await tokenOf(stranger.owner);
      const noToken = await sellerCall('GET', `/api/shops/${shopId}/members`);
      expect([noToken.status, noToken.data?.code]).toEqual([401, 'invalid_token']);
      const notMember = await sellerCall('GET', `/api/shops/${shopId}/members`, undefined, strangerToken);
      expect([notMember.status, notMember.data?.code]).toEqual([404, 'shop_not_found']);
      const unknown = await sellerCall('GET', `/api/shops/${UNKNOWN_ID}/members`, undefined, strangerToken);
      expect([unknown.status, unknown.data?.code]).toEqual([404, 'shop_not_found']);
      const noPermission = await sellerCall('POST', `/api/shops/${shopId}/invites`, { email: uniqueEmail('x'), role: 'VIEWER' }, token);
      expect([noPermission.status, noPermission.data?.code]).toEqual([403, 'permission_denied']);
      const rename = await sellerCall('PATCH', `/api/shops/${shopId}`, { name: 'Nope Nope' }, token);
      expect([rename.status, rename.data?.code]).toEqual([403, 'permission_denied']);
      // A suspended shop: the permission is checked before the status gate (a viewer gets 403 permission_denied, a stranger still 404).
      setShopStatus(shopId, 'SUSPENDED');
      const gateViewer = await sellerCall('POST', `/api/shops/${shopId}/invites`, { email: uniqueEmail('x'), role: 'VIEWER' }, token);
      expect([gateViewer.status, gateViewer.data?.code]).toEqual([403, 'permission_denied']);
      const gateStranger = await sellerCall('POST', `/api/shops/${shopId}/invites`, { email: uniqueEmail('x'), role: 'VIEWER' }, strangerToken);
      expect([gateStranger.status, gateStranger.data?.code]).toEqual([404, 'shop_not_found']);
      const gateOwner = await sellerCall('POST', `/api/shops/${shopId}/invites`, { email: uniqueEmail('x'), role: 'VIEWER' }, await tokenOf(owner));
      expect([gateOwner.status, gateOwner.data?.code]).toEqual([403, 'shop_suspended']);
    } finally {
      await context.close();
    }
  });

  test('W04 AS-54: an owner whose session still says BUYER sees the whole menu @desktop', async ({ page }) => {
    covers('entry.rbac.session-role-ignored');
    const member = await register(page);
    const session = await page.request.get('/api/bff/session');
    expect(((await session.json()) as { user?: { role?: string } }).user?.role).not.toBe('SELLER');
    const { shopId } = await openShopByApi(member); // through the API: the browser session is not refreshed
    const again = await page.request.get('/api/bff/session');
    expect(((await again.json()) as { user?: { role?: string } }).user?.role, 'the session claim is not SELLER').not.toBe('SELLER');
    await page.goto(`${HOME}/${shopId}`);
    await expect((await sellerNav(page)).getByRole('link')).toHaveCount(ENTRY_COUNT.OWNER + 2);
  });

  test('W04 AS-54: a demoted member loses entries on the next load; a removed member gets the not-found page @desktop', async ({ browser }) => {
    covers('entry.rbac.role-change-effect', 'entry.rbac.removed-member');
    test.setTimeout(240_000);
    const { page, context, member, shopId, owner } = await memberWithRole(browser, 'ADMIN');
    try {
      const ownerToken = await tokenOf(owner);
      const memberId = userId(member.email);
      await page.goto(`${HOME}/${shopId}`);
      await expect((await sellerNav(page)).getByRole('link', { name: 'API keys' })).toHaveCount(1);
      // The live stream the open page holds.
      const watch = watchApi(page);
      watch.reset();

      const demote = await sellerCall('PATCH', `/api/shops/${shopId}/members/${memberId}`, { role: 'STAFF' }, ownerToken);
      expect(demote.status, JSON.stringify(demote.data)).toBe(204);
      expect(scalar(`select role from "ShopMembership" where "shopId"='${shopId}' and "userId"='${memberId}'`)).toBe('STAFF');
      expect(rows(`select count(*) from "Outbox" where "aggregateId"='${shopId}' and "eventName"='tenancy.member_role_changed' and payload->'payload'->>'userId'='${memberId}'`)[0]![0]).toBe('1');
      // Next load: at once (the authorization cache is dropped), the admin entries are gone.
      await page.goto(`${HOME}/${shopId}`);
      const nav = await sellerNav(page);
      await expect(nav.getByRole('link', { name: 'API keys' })).toHaveCount(0);
      await expect(nav.getByRole('link', { name: 'Import' })).toHaveCount(1);
      await page.goto(`${HOME}/${shopId}/developers/api-keys`);
      await expect(page.getByRole('heading', { name: "You don't have access to this page." })).toBeVisible();
      await expect(page.getByText('Your role in this shop: Staff.')).toBeVisible();
      const asStaff = await sellerCall('GET', `/api/shops/${shopId}`, undefined, await tokenOf(member));
      expect(asStaff.data.myRole).toBe('STAFF');
      // The other way: promoted again.
      expect((await sellerCall('PATCH', `/api/shops/${shopId}/members/${memberId}`, { role: 'ADMIN' }, ownerToken)).status).toBe(204);
      await page.goto(`${HOME}/${shopId}`);
      await expect((await sellerNav(page)).getByRole('link', { name: 'API keys' })).toHaveCount(1);

      // Removed: the page is the not-found page, the API says 404, the row is gone, the outbox says so.
      await page.goto(`${HOME}/${shopId}`);
      await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
      // The page's live stream for this shop (the overview opens one): it must end when the member is removed.
      const streams = new Map<string, boolean>();
      page.on('request', (request) => {
        if (/\/api\/streams\?/.test(request.url()) && decodeURIComponent(request.url()).includes(`shop:${shopId}`)) streams.set(request.url(), false);
      });
      page.on('requestfinished', (request) => streams.has(request.url()) && streams.set(request.url(), true));
      page.on('requestfailed', (request) => streams.has(request.url()) && streams.set(request.url(), true));
      await page.reload();
      await expect(page.getByRole('region', { name: 'Last 30 days', exact: true })).toBeVisible();
      await expect.poll(() => streams.size, { message: 'the overview opens its live stream' }).toBeGreaterThan(0);
      expect([...streams.values()].some((closed) => !closed), 'the stream is open before the removal').toBe(true);
      const removed = await sellerCall('DELETE', `/api/shops/${shopId}/members/${memberId}`, undefined, ownerToken);
      expect(removed.status, JSON.stringify(removed.data)).toBe(204);
      expect(scalar(`select count(*) from "ShopMembership" where "shopId"='${shopId}' and "userId"='${memberId}'`)).toBe('0');
      expect(rows(`select count(*) from "Outbox" where "aggregateId"='${shopId}' and "eventName"='tenancy.member_removed'`)[0]![0]).toBe('1');
      await expect.poll(() => [...streams.values()].every(Boolean), { message: 'the open live stream closes', timeout: 30_000 }).toBe(true);
      await page.goto(`${HOME}/${shopId}`);
      await expect(page.getByText("We couldn't find that shop.").first()).toBeVisible();
      const after = await sellerCall('GET', `/api/shops/${shopId}`, undefined, await tokenOf(member));
      expect([after.status, after.data?.code]).toEqual([404, 'shop_not_found']);
    } finally {
      await context.close();
    }
  });

  test('W04 AS-54: OWNER of one shop and VIEWER of another gets different menus and the switch re-evaluates them @desktop', async ({ page }) => {
    covers('entry.rbac.member-in-two-shops');
    const member = await register(page);
    const me = { email: member.email, password: NEW_USER_PASSWORD };
    const own = await openShopByApi(me, 'Aiqa Mine');
    const other = await ownerByApi('Aiqa Theirs');
    await acceptInvite(page, other.owner, other.shopId, me, 'VIEWER');
    expect(rows(`select s.name, m.role from "ShopMembership" m join "Shop" s on s.id=m."shopId" where m."userId"='${userId(me.email)}' order by s.name`)).toEqual([['Aiqa Mine', 'OWNER'], ['Aiqa Theirs', 'VIEWER']]);
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, await tokenOf(me))).data.items as { id: string; role: string }[];
    expect(Object.fromEntries(mine.map((s) => [s.id, s.role]))).toEqual({ [own.shopId]: 'OWNER', [other.shopId]: 'VIEWER' });
    await page.goto(`${HOME}/${own.shopId}`);
    await expect((await sellerNav(page)).getByRole('link')).toHaveCount(ENTRY_COUNT.OWNER + 2);
    await page.goto(`${HOME}/${other.shopId}`);
    await expect((await sellerNav(page)).getByRole('link')).toHaveCount(ENTRY_COUNT.VIEWER + 2);
    // Switch through the switcher from the owner's inventory to the other shop's: the menu follows.
    await page.goto(`${HOME}/${own.shopId}/developers/api-keys`);
    const { sellerMenu } = await import('./helpers');
    const menu = await sellerMenu(page);
    await menu.getByRole('button').first().click();
    await menu.getByRole('list', { name: 'Your shops' }).getByRole('link').filter({ hasText: 'Aiqa Theirs' }).click();
    await expect(page).toHaveURL(`${HOME}/${other.shopId}/developers/api-keys`);
    await expect(page.getByRole('heading', { name: "You don't have access to this page." })).toBeVisible();
    await page.goto(`${HOME}/${other.shopId}`);
    await expect((await sellerNav(page)).getByRole('link', { name: 'API keys' })).toHaveCount(0);
  });

  test('W04 AS-99: the matrix route equals S03; a different X-Shop-Id is 400; every shop route refuses a request with no token @desktop', async ({ page }) => {
    covers('entry.rbac.shop-roles-matrix-api', 'entry.rbac.x-shop-id-mismatch', 'entry.rbac.anonymous-401');
    const member = await register(page);
    const a = await openShopByApi(member);
    const b = await openShopByApi(member);
    const token = await tokenOf(member);
    const roles = await sellerCall('GET', '/api/shop-roles', undefined, token);
    expect(roles.status).toBe(200);
    for (const role of ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const) expect([...roles.data.roles[role]].sort(), role).toEqual([...MATRIX[role]].sort());
    expect([...roles.data.permissions].sort()).toEqual([...MATRIX.OWNER].sort());
    expect((await sellerCall('GET', '/api/shop-roles')).status).toBe(401);

    const mismatch = await fetch(`${API_URL}/api/shops/${a.shopId}/members`, { headers: { authorization: `Bearer ${token}`, 'x-shop-id': b.shopId } });
    const body = (await mismatch.json()) as { code?: string };
    expect([mismatch.status, body.code]).toEqual([400, 'shop_mismatch']);
    const same = await fetch(`${API_URL}/api/shops/${a.shopId}/members`, { headers: { authorization: `Bearer ${token}`, 'x-shop-id': a.shopId } });
    expect(same.status).toBe(200);

    const anonymous: [string, string, unknown?][] = [
      ['POST', '/api/shops', { name: 'Nobody', slug: slugOf('anon') }],
      ['GET', '/api/shops/mine'],
      ['GET', `/api/shops/${a.shopId}`],
      ['PATCH', `/api/shops/${a.shopId}`, { name: 'Nobody' }],
      ['GET', `/api/shops/${a.shopId}/members`],
      ['PATCH', `/api/shops/${a.shopId}/members/${UNKNOWN_ID}`, { role: 'VIEWER' }],
      ['DELETE', `/api/shops/${a.shopId}/members/${UNKNOWN_ID}`],
      ['GET', `/api/shops/${a.shopId}/invites`],
      ['POST', `/api/shops/${a.shopId}/invites`, { email: 'a@example.com', role: 'VIEWER' }],
      ['POST', `/api/shops/${a.shopId}/offboarding`, { confirmSlug: 'x' }],
      ['DELETE', `/api/shops/${a.shopId}/offboarding`],
      ['GET', `/api/shops/${a.shopId}/export`],
    ];
    for (const [method, route, payload] of anonymous) {
      const result = await sellerCall(method, route, payload);
      expect([result.status, result.data?.code], `${method} ${route}`).toEqual([401, 'invalid_token']);
    }
    expect(scalar(`select count(*) from "Shop" where slug like 'aiqa-anon-%'`)).toBe('0');

    // On the screen: the Roles tab shows the same matrix (a table on a wide screen, cards on a phone); a signed-out visit to a shop address is sent to sign-in.
    if (!isPhone(page)) {
      await page.goto(`${HOME}/${a.shopId}/team?tab=roles`);
      const labelOf: Record<string, string> = { 'shop.read': 'View shop details', 'shop.manage': 'Edit shop settings', 'members.manage': 'Manage team members', 'payouts.read': 'View payouts', 'shop.delete': 'Close the shop', 'products.write': 'Create and edit products' };
      const table = page.getByRole('table', { name: 'Roles and permissions' });
      await expect(table).toBeVisible();
      for (const [permission, label] of Object.entries(labelOf)) {
        const cells = await table.getByRole('row').filter({ hasText: label }).first().getByRole('cell').allInnerTexts();
        const shown = cells.map((text) => text.trim());
        expect(shown, permission).toEqual((['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const).map((role) => (MATRIX[role].includes(permission) ? 'Allowed' : 'Not allowed')));
      }
    }
    // (The web server's own route to the API does not pass an X-Shop-Id from the browser on, so that rule is reachable by API only.)
    await page.context().clearCookies();
    await page.goto(`${HOME}/${a.shopId}`);
    await expect(page).toHaveURL(/\/login/);
  });

  test('W04 AS-99: the 201 body, the rows in all four tables and the two outbox events written together @desktop', async ({ page }) => {
    covers('entry.api.shops-create-response', 'entry.api.outbox-shop-created');
    const member = await register(page);
    const token = await tokenOf({ email: member.email });
    const slug = slugOf('create');
    const created = await sellerCall('POST', '/api/shops', { name: '  Aiqa Create Shop  ', slug }, token);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const shop = created.data;
    expect(shop).toMatchObject({ name: 'Aiqa Create Shop', slug, plan: 'STARTER', status: 'ACTIVE', verificationStatus: 'UNVERIFIED', payoutsEnabled: false, shopVersion: 1, purgeAt: null, myRole: 'OWNER' });
    expect(shop.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof shop.region).toBe('string');
    expect(new Date(shop.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect([...shop.myPermissions].sort()).toEqual([...MATRIX.OWNER].sort());

    const [row] = rows(`select name, slug, plan, status, "verificationStatus", "payoutsEnabled", "shopVersion", "purgeAt" is null, "sandboxOf" is null from "Shop" where id='${shop.id}'`);
    expect(row).toEqual(['Aiqa Create Shop', slug, 'STARTER', 'ACTIVE', 'UNVERIFIED', 'f', '1', 't', 't']);
    expect(rows(`select role, source from "ShopMembership" where "shopId"='${shop.id}'`)).toEqual([['OWNER', 'owner']]);
    expect(rows(`select region from "ShopDirectory" where "shopId"='${shop.id}'`)).toEqual([[shop.region]]);
    expect(rows(`select "from", "to", actor from "ShopStatusHistory" where "shopId"='${shop.id}'`)).toEqual([['', 'ACTIVE', userId(member.email)]]);
    const events = rows(`select "eventName", "createdAt"::text, payload->'payload'->>'shopId', payload->'payload'->>'ownerId', payload->'payload'->>'userId' from "Outbox" where "aggregateId"='${shop.id}' order by "eventName"`);
    expect(events.map((e) => e[0])).toEqual(['tenancy.member_added', 'tenancy.shop_created']);
    expect(events[0]![1], 'written in the same transaction (same time)').toBe(events[1]![1]);
    expect(events[1]).toEqual(['tenancy.shop_created', events[1]![1], shop.id, userId(member.email), '']);
    expect(events[0]![4]).toBe(userId(member.email));
    // In the browser the new shop opens under its name with the owner's whole menu.
    await page.goto(`${HOME}/${shop.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Aiqa Create Shop' })).toBeVisible();
    await expect((await sellerNav(page)).getByRole('link')).toHaveCount(ENTRY_COUNT.OWNER + 2);
  });

  test('W04 AS-99: paging by cursor with bad values refused, one answer for unknown, malformed and foreign ids, sandbox shops not listed @desktop', async ({ page }) => {
    covers('entry.api.shops-mine-paging', 'entry.api.shops-get', 'entry.api.sandbox-not-listed');
    const member = await register(page);
    const me = { email: member.email };
    const shops = [await openShopByApi(me, 'Aiqa Page 1'), await openSecondShop(me, 'Aiqa Page 2'), await openSecondShop(me, 'Aiqa Page 3')];
    const token = await tokenOf(me);
    const first = (await sellerCall('GET', '/api/shops/mine?limit=2', undefined, token)).data as { items: { id: string }[]; nextCursor: string | null };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (await sellerCall('GET', `/api/shops/mine?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, undefined, token)).data as { items: { id: string }[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((s) => s.id))).toEqual(new Set(shops.map((s) => s.shopId)));
    // Bad values: S03 B-04 names the codes invalid_limit and invalid_cursor.
    for (const query of ['limit=0', 'limit=abc', 'limit=-1', 'limit=101', 'limit=1.5']) {
      const bad = await sellerCall('GET', `/api/shops/mine?${query}`, undefined, token);
      expect.soft([bad.status, bad.data?.code], query).toEqual([400, 'invalid_limit']);
    }
    for (const query of ['cursor=garbage', 'cursor=%00', `cursor=${'a'.repeat(400)}`]) {
      const bad = await sellerCall('GET', `/api/shops/mine?${query}`, undefined, token);
      expect.soft([bad.status, bad.data?.code], query.slice(0, 20)).toEqual([400, 'invalid_cursor']);
    }

    // GET /shops/:id: a member sees the shop with role and permissions; the three kinds of "no" answer the same.
    const read = await sellerCall('GET', `/api/shops/${shops[0]!.shopId}`, undefined, token);
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ id: shops[0]!.shopId, name: 'Aiqa Page 1', myRole: 'OWNER' });
    expect(read.data.myPermissions).toHaveLength(MATRIX.OWNER.length);
    const foreign = await ownerByApi();
    const answers = [
      await sellerCall('GET', `/api/shops/${UNKNOWN_ID}`, undefined, token),
      await sellerCall('GET', '/api/shops/not-a-uuid', undefined, token),
      await sellerCall('GET', `/api/shops/${foreign.shopId}`, undefined, token),
    ].map((r) => ({ status: r.status, code: r.data?.code, message: r.data?.message ?? r.data?.title }));
    expect(answers[0]).toMatchObject({ status: 404, code: 'shop_not_found' });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    await page.goto(`${HOME}/${shops[0]!.shopId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Aiqa Page 1' })).toBeVisible();
    await page.goto(`${HOME}/${foreign.shopId}`);
    await expect(page.getByText("We couldn't find that shop.").first()).toBeVisible();

    // A sandbox shop of the same member (handle <slug>-sandbox) is never listed, neither by the API nor by the pages.
    const live = shops[0]!.shopId;
    const liveSlug = scalar(`select slug from "Shop" where id='${live}'`);
    const sandboxName = 'Aiqa Sandbox Twin';
    sql(`with s as (insert into "Shop"(slug,name,"sandboxOf") values ('${liveSlug}-sandbox','${sandboxName}','${live}') returning id) insert into "ShopMembership"("shopId","userId",role,source) select id,'${userId(me.email)}','OWNER','owner' from s`);
    expect(scalar(`select count(*) from "ShopMembership" m join "Shop" s on s.id=m."shopId" where m."userId"='${userId(me.email)}' and s."sandboxOf" is not null`)).toBe('1');
    const list = (await sellerCall('GET', '/api/shops/mine?limit=50', undefined, token)).data.items as { id: string; name: string }[];
    expect(list.map((s) => s.name)).not.toContain(sandboxName);
    expect(list).toHaveLength(3);
    await page.goto(HOME);
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByText(sandboxName)).toHaveCount(0);
    await page.goto(`${HOME}/${live}`);
    const { sellerMenu } = await import('./helpers');
    const menu = await sellerMenu(page);
    await menu.getByRole('button').first().click();
    await expect(menu.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(3);
    await expect(menu.getByText(sandboxName)).toHaveCount(0);
  });

  test('W04 AS-99: an owner or admin renames (row, version, outbox); other fields and other roles are refused @desktop', async ({ browser }) => {
    covers('entry.api.shops-patch-rename');
    test.setTimeout(180_000);
    const { page, context, shopId, owner } = await memberWithRole(browser, 'STAFF');
    try {
      const ownerToken = await tokenOf(owner);
      const staff = await sellerCall('PATCH', `/api/shops/${shopId}`, { name: 'Staff Rename' }, await tokenOf({ email: (await (await page.request.get('/api/bff/session')).json()).user.email }));
      expect([staff.status, staff.data?.code]).toEqual([403, 'permission_denied']);
      const before = rows(`select name, "shopVersion", slug, plan, status from "Shop" where id='${shopId}'`)[0]!;
      const renamed = await sellerCall('PATCH', `/api/shops/${shopId}`, { name: '  Aiqa Renamed  ' }, ownerToken);
      expect(renamed.status, JSON.stringify(renamed.data)).toBe(200);
      expect(renamed.data).toMatchObject({ name: 'Aiqa Renamed', shopVersion: Number(before[1]) + 1 });
      expect(rows(`select name, "shopVersion", slug, plan, status from "Shop" where id='${shopId}'`)[0]).toEqual(['Aiqa Renamed', String(Number(before[1]) + 1), before[2], before[3], before[4]]);
      expect(rows(`select count(*) from "Outbox" where "aggregateId"='${shopId}' and "eventName"='tenancy.shop_updated'`)[0]![0]).toBe('1');
      for (const body of [{ name: 'Aiqa Renamed', slug: 'other-slug' }, { name: 'Aiqa Renamed', plan: 'PRO' }, { name: 'Aiqa Renamed', status: 'SUSPENDED' }, {}, { name: 'a' }, { name: 'x'.repeat(81) }]) {
        const refused = await sellerCall('PATCH', `/api/shops/${shopId}`, body, ownerToken);
        expect([refused.status, refused.data?.code], JSON.stringify(body).slice(0, 40)).toEqual([400, 'validation_failed']);
      }
      expect(rows(`select slug, plan, status, name from "Shop" where id='${shopId}'`)[0]).toEqual([before[2], before[3], before[4], 'Aiqa Renamed']);
      // On the screen the staff member sees the new name in the page head and the switcher button.
      await page.goto(`${HOME}/${shopId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Aiqa Renamed' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('W04 AS-99: the 11th owned shop is refused and ten parallel creations leave exactly ten @desktop', async ({ page }) => {
    covers('entry.api.shop-limit-db');
    test.setTimeout(240_000);
    const member = await register(page);
    const me = { email: member.email };
    await openShopByApi(me);
    for (let i = 0; i < 7; i++) await openSecondShop(me, `Aiqa Limit ${i}`);
    const token = await tokenOf(me);
    const count = () => scalar(`select count(*) from "ShopMembership" where "userId"='${userId(me.email)}' and role='OWNER'`);
    expect(count()).toBe('8');
    // Five at once while two slots are free: two succeed, three are refused, never more than ten.
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => sellerCall('POST', '/api/shops', { name: `Aiqa Race ${i}`, slug: slugOf(`race${i}`) }, token)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.data?.code))).toEqual([201, 201, 409, 409, 409]);
    expect(count()).toBe('10');
    const eleventh = await sellerCall('POST', '/api/shops', { name: 'Aiqa Eleventh', slug: slugOf('eleventh') }, token);
    expect(eleventh.status).toBe(409);
    expect(count()).toBe('10');
    expect(scalar(`select count(*) from "Shop" where name='Aiqa Eleventh'`)).toBe('0');
    await page.goto(HOME);
    await expect(page.getByRole('list', { name: 'Your shops' }).getByRole('listitem')).toHaveCount(10);
    await expect(page.getByRole('heading', { name: 'Open your shop' })).toHaveCount(0);
  });

  test('W04 AS-99: the demo seller has one active shop as owner and signs in straight onto it @desktop', async ({ page }) => {
    covers('entry.api.demo-seller-state');
    const login = await sellerCall('POST', '/api/auth/login', { email: SEED.seller, password: SEED.password });
    expect(login.status).toBe(200);
    const mine = (await sellerCall('GET', '/api/shops/mine', undefined, login.data.accessToken.token)).data as { items: { id: string; role: string; status: string; name: string }[]; nextCursor: string | null };
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
    expect(mine.nextCursor).toBeNull();
    expect(rows(`select s.id, m.role, s.status from "Shop" s join "ShopMembership" m on m."shopId"=s.id join "User" u on u.id=m."userId" where u.email='${SEED.seller}'`)).toEqual([[mine.items[0]!.id, 'OWNER', 'ACTIVE']]);
    // Signed in by the session route (read only), the entry page lands on the shop at once.
    const signIn = await page.request.post('/api/bff/session', { data: { email: SEED.seller, password: SEED.password } });
    expect(signIn.status()).toBeLessThan(300);
    await page.goto(HOME);
    await expect(page).toHaveURL(`${HOME}/${mine.items[0]!.id}`);
  });
});

void (undefined as unknown as Page);
}
