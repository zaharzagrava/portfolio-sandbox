import { test, expect, type Browser, type Page } from '@playwright/test';
import { SEED, createIsolatedProduct, login, openProductChat, register } from './helpers';

/**
 * W05 JC: the product chat as two people live it. Happy path only; every failure form, reconnect and rate limit is a unit
 * test (test-plan.md). Each test makes its own product (desktop and mobile run at the same time) and its own buyer.
 */

/** The seller opens the product's chat with the explicit button (AS-04); a new buyer joins from the product page (AS-01). */
async function startChat(browser: Browser) {
  const { id, title } = await createIsolatedProduct();
  const sellerContext = await browser.newContext();
  const buyerContext = await browser.newContext();
  const seller = await sellerContext.newPage();
  const buyer = await buyerContext.newPage();

  await login(seller, SEED.seller, SEED.password, `/chat?product=${id}`);
  await seller.getByRole('button', { name: 'Open chat for this product' }).click();
  await expect(seller.getByTestId('chat-title')).toHaveText(title, { timeout: 20_000 }); // created on first open; slower under parallel load
  await expect(seller).toHaveURL(/\/chat\?channel=[0-9a-f-]{36}$/);

  await register(buyer);
  await openProductChat(buyer, id);
  await expect(buyer.getByTestId('chat-title')).toHaveText(title);
  return { id, title, seller, buyer, close: async () => void (await Promise.all([sellerContext.close(), buyerContext.close()])) };
}

const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
};

/** On a phone one pane shows at a time: go back from the conversation to the list of chats. */
const backToList = async (page: Page) => {
  const back = page.getByRole('link', { name: 'Back to all chats' });
  if (await back.isVisible()) await back.click();
};

test.describe('Product chat', () => {
  test('buyer and seller exchange messages on a product chat', async ({ browser }) => {
    const { id, title, buyer, close } = await startChat(browser);

    // AS-14, AS-22: the buyer's question appears at once as theirs.
    const question = `Is the chair still available? ${Date.now()}`;
    await send(buyer, question);
    const sent = buyer.getByTestId('chat-message').filter({ hasText: question });
    await expect(sent).toContainText('You');
    await expect(sent).not.toContainText('Sending…');

    // AS-12: the history is there when the buyer comes back.
    await buyer.reload();
    await expect(buyer.getByTestId('chat-message').filter({ hasText: question })).toBeVisible();
    await expect(buyer.getByTestId('chat-title')).toHaveText(title);
    expect(id).toBeTruthy();

    await close();
  });

  test('a message arrives without a reload and the other inbox shows it as unread', async ({ browser }) => {
    const { title, seller, buyer, close } = await startChat(browser);

    // AS-23: the buyer asks; the seller's open conversation shows it without a reload (live hint, or the 15 s safety sync).
    const question = `Does it ship today? ${Date.now()}`;
    await send(buyer, question);
    await expect(seller.getByTestId('chat-message').filter({ hasText: question })).toBeVisible({ timeout: 20_000 });

    // AS-07: the buyer looks at the list of chats, and the seller's answer shows up there as an unread message.
    // (The live connection is opened with the chat's topic a moment after the page; the seller answers once it is listening.)
    const listening = buyer.waitForResponse((response) => /\/api\/streams\?topics=.*chat:/.test(response.url()));
    await buyer.goto('/chat');
    await listening;
    const row = buyer.getByRole('link', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    const answer = `Yes, ships tomorrow ${Date.now()}`;
    await send(seller, answer);
    await expect(seller.getByTestId('chat-message').filter({ hasText: answer })).toContainText('You');
    await expect(row.getByText('1 unread message')).toBeVisible({ timeout: 20_000 });

    await close();
  });

  test('reading clears the unread badge and the sender sees "Seen"', async ({ browser }) => {
    const { title, seller, buyer, close } = await startChat(browser);
    const question = `Can I collect it? ${Date.now()}`;
    await send(buyer, question);
    await expect(seller.getByTestId('chat-message').filter({ hasText: question })).toBeVisible({ timeout: 20_000 });

    // The buyer is on the list when the answer comes: the badge is there until the buyer actually reads it.
    const listening = buyer.waitForResponse((response) => /\/api\/streams\?topics=.*chat:/.test(response.url()));
    await buyer.goto('/chat');
    await listening;
    const row = buyer.getByRole('link', { name: new RegExp(title) });
    const answer = `Yes, from 5pm ${Date.now()}`;
    await send(seller, answer);
    await expect(row.getByText('1 unread message')).toBeVisible({ timeout: 20_000 });

    // AS-31: opening the chat and seeing the answer marks it read, and the badge goes.
    await row.click();
    await expect(buyer.getByTestId('chat-message').filter({ hasText: answer })).toBeVisible();
    await backToList(buyer);
    await expect(buyer.getByRole('link', { name: new RegExp(title) }).getByText(/unread message/)).toHaveCount(0, { timeout: 20_000 });

    // AS-33: the seller's answer was read, so the seller sees "Seen" under it.
    await expect(seller.getByTestId('seen-by')).toHaveText('Seen', { timeout: 20_000 });

    await close();
  });
});
