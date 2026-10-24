import { expect, test } from '@playwright/test';
import { register, shopPath } from './helpers';
import { openShopByApi } from './seller-setup';

/**
 * W04 journey "developers" (AS-45, AS-53, AS-57, AS-64): the owner of a freshly opened shop creates an API key and sees its
 * secret once, revokes it, adds a webhook endpoint (its signing secret shown once) and sends a test event. The shop is the
 * member's own, so no other test shares its keys or endpoints (L-005).
 *
 * Step 4 needs an address the API accepts and a receiver that answers (S43 FR-041, the local-receiver allowance). Without
 * `WEBHOOK_E2E_URL` the endpoint is added at a public address the sandbox may refuse; a refusal marks steps 3 and 4 blocked
 * (L-003) instead of failing, because the refusal is the API's documented answer and AS-59 covers its wording.
 */

const KEY_NAME = 'E2E pipeline';
const HOOK_URL = process.env.WEBHOOK_E2E_URL ?? 'https://example.com/hooks/e2e';

test.describe('Seller developers', () => {
  test('owner creates and revokes a key, adds an endpoint and sends a test event', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); // "Copy" counts as copied only when the browser allows the write
    const member = await register(page);
    const { shopId } = await openShopByApi(member);

    // Step 1 (AS-45, AS-46): create a test key; the secret is shown once, and the list shows the prefix only.
    await page.goto(shopPath(shopId, 'developers/api-keys'));
    await expect(page.getByText('No API keys yet. Create one to start calling the API.')).toBeVisible();
    await page.getByRole('button', { name: 'Create key' }).first().click();
    const create = page.getByRole('dialog', { name: 'Create key' });
    await create.getByLabel('Name').fill(KEY_NAME);
    await create.getByRole('button', { name: 'Create key' }).click();
    const reveal = page.getByRole('dialog', { name: 'Save your API key' });
    await expect(reveal).toBeVisible();
    const secret = (await reveal.getByLabel('Secret').textContent()) ?? '';
    expect(secret).toMatch(/^sk_test_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/);
    await page.keyboard.press('Escape');
    await expect(reveal).toBeVisible();
    await reveal.getByRole('button', { name: 'Done' }).click();
    await reveal.getByRole('button', { name: 'Close anyway' }).click();
    await expect(reveal).toBeHidden();
    const keyRow = page.getByRole('row').filter({ hasText: KEY_NAME });
    await expect(keyRow).toContainText(`${secret.slice(0, 'sk_test_'.length + 12)}…`);
    await expect(keyRow).toContainText('Active');
    await expect(page.locator('body')).not.toContainText(secret);

    // Step 2 (AS-53): revoke asks first; the row is then revoked and has no actions.
    await page.getByRole('button', { name: `Actions for ${KEY_NAME}` }).click();
    await page.getByRole('menuitem', { name: 'Revoke' }).click();
    const revoke = page.getByRole('dialog', { name: 'Revoke this key?' });
    await expect(revoke.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await revoke.getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.getByText('Key revoked')).toBeVisible();
    await expect(keyRow).toContainText('Revoked');
    await expect(keyRow.getByRole('button', { name: /Actions for/ })).toHaveCount(0);

    // Step 3 (AS-57): add an endpoint; the signing secret is shown once.
    await page.goto(shopPath(shopId, 'developers/webhooks'));
    await expect(page.getByText('No webhook endpoints yet. Add one to receive events.')).toBeVisible();
    await page.getByRole('button', { name: 'Add endpoint' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add endpoint' });
    await add.getByLabel('Endpoint URL').fill(HOOK_URL);
    await expect(add.getByRole('checkbox').first()).toBeVisible();
    await add.getByRole('button', { name: 'Add endpoint' }).click();
    const hookReveal = page.getByRole('dialog', { name: 'Webhook signing secret' });
    const rejected = add.locator('#endpoint-url-error');
    await expect(hookReveal.or(rejected)).toBeVisible();
    if (await rejected.isVisible()) {
      test.info().annotations.push({ type: 'blocked', description: `steps 3 and 4: the API refused ${HOOK_URL}; set WEBHOOK_E2E_URL to a local receiver (S43 FR-041, L-003)` });
      return;
    }
    expect(await hookReveal.getByLabel('Secret').textContent()).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    await hookReveal.getByRole('button', { name: 'Copy' }).click();
    await hookReveal.getByRole('button', { name: 'Done' }).click();
    await expect(hookReveal).toBeHidden();
    await expect(page.getByRole('link', { name: HOOK_URL })).toBeVisible();

    // Step 4 (AS-64): a test event shows as a ping delivery on the endpoint's page.
    await page.getByRole('link', { name: HOOK_URL }).click();
    await expect(page.getByRole('heading', { level: 1, name: HOOK_URL })).toBeVisible();
    await page.getByRole('button', { name: 'Send test event' }).click();
    await expect(page.getByText('Test event queued')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'webhook.ping' }).first()).toBeVisible({ timeout: 45_000 });
  });
});
