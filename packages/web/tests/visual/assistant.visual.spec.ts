import { expect, test, type Page, type Route } from '@playwright/test';
import { askAssistant, openAssistant, register } from '../helpers';
import { expectNoSeriousViolations } from './axe';
import { frame, problem, stubApi } from './stubs';

/**
 * W05 VA: the layouts of the assistant sheet at the phone (390 x 800, full screen) and desktop (1280 x 800, panel on the right)
 * widths. The backend is stubbed through `page.route` (layout only, no behaviour: the unit tests prove behaviour); a real member is
 * registered because the sheet shows the composer only to a signed-in session. Each state is scanned with axe (serious or
 * critical = 0) and compared to a committed baseline per project.
 */
const CONVERSATION = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const SECOND = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const THIRD = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d';
const SEND = new RegExp(`^/api/assistant/conversations/${CONVERSATION}/messages$`);
const RESUME = /^\/api\/assistant\/messages\/[^/]+\/stream$/;
const NOON = '2026-10-17T12:00:00.000Z';

test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 800 } : { width: 1280, height: 800 });
});

/** Answers the POST that sends a message (the same address also serves the history read, which the member stub answers). */
const routeSend = (page: Page, handler: (route: Route) => unknown) =>
  page.route(
    (url) => SEND.test(url.pathname),
    (route) => (route.request().method() === 'POST' ? handler(route) : route.fallback()),
  );

const sheet = (page: Page) => page.getByRole('dialog', { name: 'AI Shopping Assistant' });

async function stubMember(page: Page, usage: { used: number; limit: number } = { used: 12_000, limit: 100_000 }) {
  await stubApi(page, 'GET', '/assistant/usage', { body: { ...usage, resetsAt: '2026-11-01T00:00:00.000Z' } });
  await stubApi(page, 'POST', '/assistant/conversations', { status: 201, body: { id: CONVERSATION, title: 'New chat', updatedAt: NOON, messageCount: 0 } });
  await stubApi(page, 'GET', `/assistant/conversations/${CONVERSATION}/messages`, { body: { conversation: { id: CONVERSATION, title: 'New chat', updatedAt: NOON }, messages: [] } });
}

async function settled(page: Page) {
  // the sheet slides in: measure it once the animation has ended
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) // a spinner or the running-reply dot never ends
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

async function check(page: Page, name: string) {
  await settled(page);
  await expectNoSeriousViolations(page);
  await expect(sheet(page)).toHaveScreenshot(`${name}.png`, { mask: [sheet(page).locator('time')] });
}

async function openAsMember(page: Page, usage?: { used: number; limit: number }) {
  await register(page);
  await stubMember(page, usage);
  return openAssistant(page);
}

test.describe('Assistant sheet layouts', () => {
  test('signed out', async ({ page }) => {
    await page.goto('/');
    await openAssistant(page);
    await expect(sheet(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
    await check(page, 'signed-out');
  });

  test('empty, with the allowance line', async ({ page }) => {
    await openAsMember(page);
    await expect(sheet(page).getByText('How can I help you today?')).toBeVisible();
    await expect(sheet(page).getByText('12% of your monthly allowance used')).toBeVisible();
    await check(page, 'empty');
  });

  test('allowance used up', async ({ page }) => {
    await openAsMember(page, { used: 100_000, limit: 100_000 });
    await expect(sheet(page).getByText(/Monthly allowance used up\. Resets/)).toBeVisible();
    await expect(sheet(page).getByRole('textbox', { name: 'Message to the assistant' })).toBeDisabled();
    await check(page, 'used-up');
  });

  test('waiting for the first word', async ({ page }) => {
    await openAsMember(page);
    // The request is left unanswered: the reply never starts, the bubble stays "Thinking…".
    await routeSend(page, () => undefined);
    await askAssistant(page, 'Which phone is best under 800 euros?');
    await expect(sheet(page).getByText('Thinking…')).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Stop generating' })).toBeVisible();
    await check(page, 'thinking');
  });

  test('tool chips and a finished answer', async ({ page }) => {
    await openAsMember(page);
    await routeSend(page, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' },
        body: [
          frame('meta', { messageId: 'm1', conversationId: CONVERSATION }, '1-0'),
          frame('tool', { id: 't1', name: 'search_products', status: 'done' }, '2-0'),
          frame('tool', { id: 't2', name: 'pickup_near_me', status: 'failed' }, '3-0'),
          frame('text', { t: 'Here are **two phones** under 800 euros:\n\n- Phone A, 599 euros\n- Phone B, 749 euros\n\nSee [the first one](/product/a).' }, '4-0'),
          frame('done', { stopReason: 'end_turn', truncated: false, usage: { inputTokens: 5, outputTokens: 9 }, allowance: { used: 13_000, limit: 100_000 } }, '5-0'),
        ].join(''),
      }),
    );
    await askAssistant(page, 'Which phone is best under 800 euros?');
    await expect(sheet(page).getByText('Searched products')).toBeVisible();
    await expect(sheet(page).getByText("Couldn't check pickup points")).toBeVisible();
    await expect(sheet(page).getByText('13% of your monthly allowance used')).toBeVisible();
    await check(page, 'answer');
  });

  test('a refusal before the stream shows an inline alert', async ({ page }) => {
    await openAsMember(page);
    await stubApi(page, 'POST', SEND, problem(422, 'input_rejected', { category: 'sensitive_data' }));
    await askAssistant(page, 'my card is 4111 1111 1111 1111');
    await expect(sheet(page).getByRole('alert')).toContainText('Your message looks like it contains a card number or a password.');
    await check(page, 'alert');
  });

  test('a reply that ends in an error keeps its partial text and shows a note', async ({ page }) => {
    await openAsMember(page);
    await routeSend(page, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' },
        body: [
          frame('meta', { messageId: 'm1', conversationId: CONVERSATION }, '1-0'),
          frame('text', { t: 'Let me look at the options' }, '2-0'),
          frame('error', { code: 'PROVIDER_UNAVAILABLE', retryAfterMs: 12_000 }, '3-0'),
        ].join(''),
      }),
    );
    await askAssistant(page, 'Which phone is best?');
    await expect(sheet(page).getByRole('alert')).toContainText('The assistant is busy right now. Try again in 12 seconds.');
    await expect(sheet(page).getByRole('button', { name: 'Try again' })).toBeVisible();
    await check(page, 'error-note');
  });

  test('a cut stream shows the partial text and "Reconnecting…"', async ({ page }) => {
    await openAsMember(page);
    await routeSend(page, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [frame('meta', { messageId: 'm1', conversationId: CONVERSATION }, '1-0'), frame('text', { t: 'Let me look at' }, '2-0')].join(''),
      }),
    );
    // the re-attach never answers, so the reconnecting state stays on screen
    await page.route((url) => RESUME.test(url.pathname), () => undefined);
    await askAssistant(page, 'Which phone is best?');
    await expect(sheet(page).getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
    await check(page, 'reconnecting');
  });

  test('the conversation list replaces the transcript inside the sheet', async ({ page }) => {
    await register(page);
    await stubMember(page);
    await stubApi(page, 'GET', '/assistant/conversations', {
      body: {
        items: [
          { id: CONVERSATION, title: 'Find a coffee grinder', updatedAt: NOON, messageCount: 4 },
          { id: SECOND, title: 'A very long conversation title that has to wrap onto a second line without any horizontal scrollbar at all', updatedAt: '2026-10-16T09:00:00.000Z', messageCount: 12 },
          { id: THIRD, title: 'Pickup near the station', updatedAt: '2026-10-10T09:00:00.000Z', messageCount: 2 },
        ],
        nextCursor: 'next',
      },
    });
    await openAssistant(page);
    await sheet(page).getByRole('button', { name: 'Chats' }).click();
    await expect(sheet(page).getByText('Find a coffee grinder')).toBeVisible();
    await expect(sheet(page).getByRole('log')).toBeHidden();
    await check(page, 'list');
  });

  test('W05 AS-65: the sheet is full screen on a phone and a right panel on desktop, with the composer inside the viewport', async ({ page }, info) => {
    await openAsMember(page);
    await settled(page);
    const box = await sheet(page).boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(viewport.height - 2);
    if (info.project.name === 'mobile') expect(box!.width).toBeGreaterThan(viewport.width - 2);
    else {
      expect(box!.width).toBeLessThan(viewport.width / 2);
      expect(box!.x + box!.width).toBeGreaterThan(viewport.width - 2);
    }
    const composer = await sheet(page).getByRole('textbox', { name: 'Message to the assistant' }).boundingBox();
    expect(composer).not.toBeNull();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
