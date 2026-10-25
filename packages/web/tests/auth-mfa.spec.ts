import { expect, test } from '@playwright/test';
import { register, signOut, totp, waitForForm } from './helpers';

/** JM (W01 AS-32, AS-46, AS-47): turn two-step verification on, save the codes, sign out, sign in with a code. */
test.describe('Two-step verification @desktop', () => {
  test('enable two-step verification, save recovery codes, sign in with a code', async ({ page }) => {
    const { email, password } = await register(page);

    await page.goto('/account/security');
    await expect(page.getByRole('heading', { level: 1, name: 'Account security' })).toBeVisible();
    await expect(page.getByText('Two-step verification is off.')).toBeVisible();
    await page.getByRole('button', { name: 'Set up' }).click();

    const setup = page.getByRole('dialog', { name: 'Set up two-step verification' });
    await expect(setup.getByRole('img', { name: /QR code for your authenticator app/ })).toBeVisible();
    const key = (await setup.locator('code').innerText()).trim();
    expect(key).toMatch(/^[A-Z2-7 ]{16,}$/);
    await setup.getByRole('button', { name: 'Next' }).click();
    await setup.getByLabel('6-digit code').fill(totp(key));
    await setup.getByRole('button', { name: 'Confirm' }).click();

    const codes = page.getByRole('dialog', { name: 'Save your recovery codes' });
    await expect(codes.getByRole('listitem')).toHaveCount(10);
    await expect(codes.getByRole('button', { name: 'Done' })).toBeDisabled();
    await codes.getByRole('checkbox', { name: "I've saved these codes" }).click();
    await codes.getByRole('button', { name: 'Done' }).click();
    await expect(codes).toBeHidden();
    await expect(page.getByText(/Two-step verification is on since/)).toBeVisible();
    await expect(page.getByText('10 recovery codes left')).toBeVisible();

    await signOut(page);

    // A code of the next 30-second step: the server accepts one step of drift and does not take the same step twice.
    await page.goto('/login');
    await waitForForm(page);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login\/mfa/);
    await waitForForm(page);
    await page.getByLabel('Authentication code').fill(totp(key, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL('http://localhost:3000/');
  });
});
