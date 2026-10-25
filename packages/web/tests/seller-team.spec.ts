import { expect, test } from '@playwright/test';
import { API_URL, readInviteLink, register, shopPath, uniqueEmail } from './helpers';
import { openShopByApi } from './seller-setup';

/**
 * W04 journey "invitation" (AS-80): the owner of a fresh shop invites a registered person by e-mail; the invitee opens the
 * link from the dev mailbox, presses "Accept invitation" and lands in the shop, with the invitation address replaced in
 * history (AS-82). The invite link is never shown to the owner, so the only way to the token is the mail.
 *
 * BLOCKED when the API has no dev mailbox that lists invitation mails (W04 L-003): the test then stops with that reason
 * instead of passing without the step.
 */

async function devMailboxLists(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/api/dev/mailbox?to=${encodeURIComponent(uniqueEmail('probe'))}`);
    return response.ok;
  } catch {
    return false;
  }
}

test.describe('Seller team @desktop', () => {
  test('invitee accepts an invitation from the e-mailed link', async ({ page, browser }) => {
    test.fixme(!(await devMailboxLists()), 'blocked: no dev outbox at /api/dev/mailbox, so the invitation link cannot be read (L-003)');

    const inviteeEmail = uniqueEmail('invitee');
    const inviteeContext = await browser.newContext();
    const invitee = await inviteeContext.newPage();
    try {
      // the two members are independent: register both at once
      const [, owner] = await Promise.all([register(invitee, inviteeEmail), register(page)]);
      const { shopId, shopName } = await openShopByApi(owner);

      await page.goto(shopPath(shopId, 'team?tab=invitations'));
      await page.getByLabel('E-mail address').fill(inviteeEmail);
      await page.getByLabel('Role', { exact: true }).selectOption('STAFF');
      await page.getByRole('button', { name: 'Send invitation' }).click();
      await expect(page.getByText(`Invitation sent to ${inviteeEmail}.`)).toBeVisible();
      await expect(page.getByRole('rowheader', { name: inviteeEmail })).toBeVisible();

      const link = await readInviteLink(inviteeEmail);
      await invitee.goto(link);
      await expect(invitee.getByText("You've been invited to join a shop.")).toBeVisible();
      await invitee.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(invitee).toHaveURL(new RegExp(`/dashboard/seller/${shopId}$`));
      await expect(invitee.getByText('You joined as Staff.')).toBeVisible();
      await expect(invitee.getByRole('heading', { level: 1, name: shopName })).toBeVisible();

      // AS-82: going back does not return to the invitation page.
      await invitee.goBack();
      await expect(invitee).not.toHaveURL(/\/invites\//);

      // The owner's list now has the invitee as a member.
      await page.goto(shopPath(shopId, 'team'));
      await expect(page.getByRole('rowheader', { name: inviteeEmail })).toBeVisible();
    } finally {
      await inviteeContext.close();
    }
  });
});
