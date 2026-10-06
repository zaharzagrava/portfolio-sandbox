import { test, expect } from '@playwright/test';
import { register } from './helpers';

/**
 * SD-42 shopping assistant: a streamed turn end to end. Locally, without ANTHROPIC_API_KEY, the backend's own
 * scripted provider answers (`echo: …`); with a key it is Claude - either way the reply streams in.
 */
test.describe('Shopping assistant', () => {
  test('ask the assistant and get a streamed reply', async ({ page }) => {
    await register(page);
    await page.getByRole('button', { name: 'AI Assistant' }).click();
    await page.getByPlaceholder('Ask me anything...').fill('Recommend a coffee grinder');
    await page.getByPlaceholder('Ask me anything...').press('Enter');

    await expect(page.getByTestId('assistant-message').last()).not.toBeEmpty({ timeout: 20_000 });
    await expect(page.getByTestId('assistant-message').last()).not.toHaveText('Recommend a coffee grinder');
  });
});
