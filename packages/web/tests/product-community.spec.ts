import { test, expect } from '@playwright/test';
import { productId, register } from './helpers';

/** Product page community features: discussions + votes (SD-11) and "ask this product" (SD-43). */
test.describe('Product community', () => {
  test('start a discussion, upvote it, and ask the product a question', async ({ page }) => {
    const id = await productId('Portable SSD 2TB');
    await register(page);
    await page.goto(`/products/${id}`);

    await page.getByRole('tab', { name: 'Discussions' }).click();
    await page.getByRole('button', { name: 'Start a Discussion' }).click();
    const title = `Does it work with USB-C? ${Date.now()}`;
    await page.getByLabel('Discussion title').fill(title);
    await page.getByLabel('Discussion body').fill('Planning to use it with a **laptop**.');
    await page.getByRole('button', { name: 'Post', exact: true }).click();

    const post = page.getByTestId('discussion-post').filter({ hasText: title });
    await expect(post).toBeVisible();
    await expect(post.locator('strong')).toHaveText('laptop'); // markdown rendered server-side, sanitized
    await post.getByRole('button', { name: 'Upvote' }).click();
    await expect(post.getByTestId('post-score')).toHaveText('1');

    // Grounded Q&A: answers come only from the shop's documents - with none uploaded it says so instead of guessing.
    await page.getByLabel('Question').fill('Is it waterproof?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.getByTestId('ask-answer').or(page.getByTestId('ask-message'))).toBeVisible();
  });
});
