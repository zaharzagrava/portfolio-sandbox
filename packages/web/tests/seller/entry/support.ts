import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, NEW_USER_PASSWORD, register, resetRateLimits, sellerCall, uniqueEmail } from '../../helpers';
import { tokenOf, type Member } from '../cross-cutting/support';
import { openShopByApi } from '../../seller-setup';

/** Shared set-up of the AI QA "entry" specs (roles, memberships, the drawer at phone width). */

export type Role = 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';

export function covers(...lines: string[]) {
  test.info().annotations.push({ type: 'aiqa-lines', description: lines.join(',') });
}

/** An owner made through the API only (no browser): registered, signed in once, with one shop. */
export async function ownerByApi(name?: string): Promise<{ owner: Required<Member>; shopId: string; shopName: string }> {
  await resetRateLimits();
  const email = uniqueEmail('aiqa-owner');
  const registered = await sellerCall('POST', '/api/auth/register', { email, password: NEW_USER_PASSWORD });
  expect(registered.status, `register ${email}: ${JSON.stringify(registered.data)}`).toBeLessThan(300);
  const opened = await openShopByApi({ email }, name);
  return { owner: { email, password: NEW_USER_PASSWORD }, ...opened };
}

const seenLinks = new Set<string>();

/** The newest invitation link mailed to `email` that this run has not used yet (a person invited to several shops gets several mails). */
async function newInviteLink(email: string, used: Set<string>): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        const response = await fetch(`${API_URL}/api/dev/mailbox?to=${encodeURIComponent(email)}`);
        if (!response.ok) return '';
        const { messages } = (await response.json()) as { messages: { links: string[] }[] };
        const link = messages.flatMap((message) => message.links).find((candidate) => candidate.includes('/invites/') && !used.has(candidate));
        found = link ?? '';
        return found;
      },
      { message: `new invitation link for ${email}`, timeout: 15_000 },
    )
    .not.toBe('');
  used.add(found);
  return new URL(found).pathname;
}

/** The owner invites `who` with `role`; `who`'s page opens the mailed link and accepts (the only way to a non-owner role). */
export async function acceptInvite(page: Page, owner: Member, shopId: string, who: Member, role: Exclude<Role, 'OWNER'>) {
  const invited = await sellerCall('POST', `/api/shops/${shopId}/invites`, { email: who.email, role }, await tokenOf(owner));
  expect(invited.status, `invite: ${JSON.stringify(invited.data)}`).toBe(201);
  await page.goto(await newInviteLink(who.email, seenLinks));
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/seller/${shopId}$`));
}

/** A fresh member, signed in, in a shop of its own with the given role (OWNER: a shop of their own). */
export async function memberWithRole(browser: Browser, role: Role): Promise<{ page: Page; context: BrowserContext; member: Required<Member>; shopId: string; shopName: string; owner: Required<Member> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const member = await register(page);
  const full = { email: member.email, password: NEW_USER_PASSWORD };
  if (role === 'OWNER') {
    const opened = await openShopByApi(full);
    return { page, context, member: full, owner: full, ...opened };
  }
  const { owner, shopId, shopName } = await ownerByApi();
  await acceptInvite(page, owner, shopId, full, role);
  return { page, context, member: full, owner, shopId, shopName };
}

/** The Seller navigation: the sidebar at desktop width, the drawer behind "Open menu" on a phone. */
export async function sellerNav(page: Page) {
  const { sellerMenu } = await import('../../helpers');
  const menu = await sellerMenu(page);
  return menu.getByRole('navigation', { name: 'Seller' });
}

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;
