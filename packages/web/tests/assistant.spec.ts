import { test, expect, type Page } from '@playwright/test';
import { askAssistant, openAssistant, register } from './helpers';

/**
 * W05 JA: the shopping assistant sheet end to end. The dev API runs the scripted provider (`LLM_PROVIDER=scripted`), which answers
 * `echo: <question>` and calls no tool; the stream and the history are the real ones. Each test signs up its own user and asks its
 * own question (L-006). Failure forms, resumes and stops are unit tests, never journeys.
 */
// Letters only: the assistant refuses a message that holds a long number that passes the card-number checksum (`input_rejected`,
// category `sensitive_data`), and about one `Date.now()` in ten does.
const unique = () => Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8) || 'abcdefgh';

async function startFresh(page: Page) {
  await register(page);
  return openAssistant(page);
}

test.describe('Shopping assistant', () => {
  test('W05 AS-41 AS-42: open the sheet from "AI Assistant", ask, and the answer streams in', async ({ page }) => {
    const question = `Recommend a coffee grinder ${unique()}`;
    const sheet = await startFresh(page);
    await expect(sheet.getByText("Hi! I'm your AI Shopping Assistant.")).toBeVisible();

    await askAssistant(page, question);

    // the question is shown at once, right-aligned in its own bubble; the answer is a different, non-empty bubble
    await expect(sheet.getByTestId('user-message').last()).toHaveText(question);
    const answer = sheet.getByTestId('assistant-message').last();
    await expect(answer).toHaveText(`echo: ${question}`, { timeout: 20_000 });
    await expect(answer).not.toHaveText(question);
    // the reply ended: Send is back and the composer is empty
    await expect(sheet.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'Message to the assistant' })).toHaveValue('');

    // the whole exchange is in the conversation history of the signed-in user
    const list = await page.request.get('/api/assistant/conversations');
    expect(list.ok()).toBe(true);
    const [conversation] = (await list.json()).items as { id: string }[];
    await expect
      .poll(async () => {
        const history = await (await page.request.get(`/api/assistant/conversations/${conversation.id}/messages`)).json();
        return history.messages.map((m: { role: string; text: string }) => [m.role, m.text]);
      })
      .toEqual([
        ['user', question],
        ['assistant', `echo: ${question}`],
      ]);
  });

  test('W05 AS-48: after a reload the conversation is still there', async ({ page }) => {
    const question = `Which kettle is best ${unique()}`;
    const sheet = await startFresh(page);
    await askAssistant(page, question);
    await expect(sheet.getByTestId('assistant-message').last()).toHaveText(`echo: ${question}`, { timeout: 20_000 });

    await page.reload();

    // the tab remembers that the sheet was open and which conversation it showed (ids only); the history comes from the server
    const reopened = page.getByRole('dialog', { name: 'AI Shopping Assistant' });
    await expect(reopened).toBeVisible();
    await expect(reopened.getByTestId('user-message')).toHaveText(question);
    await expect(reopened.getByTestId('assistant-message')).toHaveText(`echo: ${question}`);
    await expect(reopened.getByText("Hi! I'm your AI Shopping Assistant.")).toBeHidden();
  });
});
