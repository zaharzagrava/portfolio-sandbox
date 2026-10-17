import { test, expect, type Page } from '@playwright/test';
import { openMenuIfCollapsed, register } from './helpers';

/**
 * S46 shopping assistant sheet: a streamed turn end to end. The dev API runs the scripted provider (`LLM_PROVIDER=scripted`),
 * which answers `echo: <question>` and calls no tool; the stream, the history and the resume are the real ones. Each test
 * signs up its own user and asks its own question (L-006).
 */
const SEND_URL = '**/api/assistant/conversations/*/messages';
// Letters only: the assistant refuses a message that holds a long number that passes the card-number checksum (`input_rejected`,
// category `sensitive_data`), and about one `Date.now()` in ten does.
const unique = () => Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8) || 'abcdefgh';
const input = (page: Page) => page.getByPlaceholder('Ask me anything...');

async function openAssistant(page: Page) {
  await register(page);
  await openMenuIfCollapsed(page); // on the phone the launcher is a menu entry
  await page.getByRole('button', { name: 'AI Assistant' }).click();
}

async function ask(page: Page, question: string) {
  await input(page).fill(question);
  await input(page).press('Enter');
}

test.describe('Shopping assistant sheet', () => {
  test('S46 AS-01: ask the assistant, the answer streams in, and the exchange is stored in the history', async ({ page }) => {
    const question = `Recommend a coffee grinder ${unique()}`;
    await openAssistant(page);
    await ask(page, question);

    await expect(page.getByTestId('assistant-message').last()).toHaveText(`echo: ${question}`, { timeout: 20_000 });

    // the whole exchange is in the conversation history of the signed-in user
    const list = await page.request.get('/api/assistant/conversations');
    expect(list.ok()).toBe(true);
    const [conversation] = (await list.json()).items as { id: string; messageCount: number }[];
    await expect.poll(async () => {
      const history = await (await page.request.get(`/api/assistant/conversations/${conversation.id}/messages`)).json();
      return history.messages.map((m: { role: string; text: string }) => [m.role, m.text]);
    }).toEqual([
      ['user', question],
      ['assistant', `echo: ${question}`],
    ]);
  });

  test('S46 AS-22: a connection that drops mid-answer resumes and shows the full text once', async ({ page }) => {
    const question = `Which kettle is best ${unique()}`;
    await openAssistant(page);
    // The page sees only the first frames of the reply (meta and the first text), then the connection ends: a cut stream.
    await page.route(SEND_URL, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      // The server may batch the text deltas into fewer frames, so the cut is made by leaving out the terminal frame (done, refusal, error)
      // rather than by counting: the stream ends without one, which is what a dropped connection looks like.
      const frames = (await response.text()).split('\n\n').filter(Boolean);
      const cut = frames.filter((frame) => !/^event: ?(done|refusal|error)/m.test(frame)).slice(0, 3).join('\n\n') + '\n\n';
      await route.fulfill({ response, body: cut });
    });
    const resumed = page.waitForResponse((r) => /\/api\/assistant\/messages\/[^/]+\/stream$/.test(r.url()) && r.request().headers()['last-event-id'] !== undefined);

    await ask(page, question);

    expect((await resumed).status()).toBe(200);
    await expect(page.getByTestId('assistant-message').last()).toHaveText(`echo: ${question}`, { timeout: 20_000 });
  });
});
