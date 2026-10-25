import { expect, test } from '@playwright/test';
import { sellerCall } from '../../helpers';
import { tokenOf } from '../cross-cutting/support';
import { covers, isPhone, memberWithRole, sellerNav, type Role } from './support';

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
  test(`entry.nav.*: a ${role} sees exactly the entries the matrix gives, the others are refused by hand with the access panel`, async ({ browser }) => {
    covers(...ENTRIES.map((e) => `entry.nav.${e.id}`), 'entry.nav.group-hidden-when-empty', 'entry.nav.team-invitations-gating', 'entry.shell.nav-account-links');
    test.setTimeout(300_000);
    const { page, context, member, shopId } = await memberWithRole(browser, role);
    try {
      // The API says what the role may do (the shop answer's myPermissions); the menu has to follow it.
      const shop = (await sellerCall('GET', `/api/shops/${shopId}`, undefined, await tokenOf(member))).data as { myRole: string; myPermissions: string[] };
      expect(shop.myRole).toBe(role);
      expect([...shop.myPermissions].sort()).toEqual([...MATRIX[role]].sort());

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
