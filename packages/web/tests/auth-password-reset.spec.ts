import { expect, test } from '@playwright/test';
import { NEW_USER_PASSWORD, getResetLink, register, resetRateLimits, signOut, waitForForm } from './helpers';

/** JR (W01 AS-39, AS-41, AS-64): request a reset link, open it from the dev mailbox, set a password, sign in with it. */
test.describe('Password reset', () => {
  test('request a reset link, set a new password, sign in with it', async ({ page }) => {
    const { email } = await register(page);
    await signOut(page);
    await resetRateLimits();

    await page.goto('/forgot-password');
    await waitForForm(page);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeFocused();

    const link = await getResetLink(email);
    const foreign: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol.startsWith('http')) foreign.push(request.url());
    });
    const response = await page.goto(link);
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    await waitForForm(page);
    await expect(page).toHaveURL('http://localhost:3000/reset-password');
    expect(new URL(page.url()).hash).toBe('');

    const next = `${NEW_USER_PASSWORD}-changed`;
    await page.getByLabel('New password', { exact: true }).fill(next);
    await page.getByLabel('Confirm new password', { exact: true }).fill(next);
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('heading', { name: 'Password updated' })).toBeFocused();
    expect(foreign).toEqual([]);

    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL('http://localhost:3000/login?notice=password_reset');
    await expect(page.getByRole('status').filter({ hasText: 'Your password was changed.' })).toBeVisible();
    await waitForForm(page);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(next);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL('http://localhost:3000/');
  });
});
