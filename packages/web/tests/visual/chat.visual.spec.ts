import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { register } from '../helpers';
import { expectNoSeriousViolations } from './axe';
import { stubApi, stubHubStream } from './stubs';

/**
 * W05 VC: the layouts of the product chat at the phone (390 x 800, one pane at a time) and desktop (1280 x 800, inbox beside
 * the conversation) widths. The browser's own `/api/chat/**` calls are stubbed through `page.route` (layout only, no behaviour:
 * the unit tests prove behaviour); a real member is registered because `/chat` is guarded on the server. Each state is scanned
 * with axe (serious or critical = 0) and compared to a committed baseline per project. Times are fixed instants in UTC and
 * the clocks of the messages are masked, so a baseline never depends on when it is taken.
 */
test.use({ timezoneId: 'UTC', locale: 'en-US' });

const stylePath = path.join(__dirname, 'hide-dev-overlay.css');

const PRODUCT = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const SHOP = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';
const SELLER = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const OTHER = '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c';
const CHANNEL = '11111111-aaaa-4aaa-8aaa-111111111111';
const SECOND = '22222222-bbbb-4bbb-8bbb-222222222222';
const THIRD = '33333333-cccc-4ccc-8ccc-333333333333';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const channelBody = (over: Record<string, unknown> = {}) => ({
  id: CHANNEL,
  productId: PRODUCT,
  shopId: SHOP,
  sellerId: SELLER,
  title: 'Espresso Machine Titanium',
  isArchived: false,
  archivedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  myRole: 'MEMBER',
  ...over,
});
const inboxItem = (over: Record<string, unknown> = {}) => ({ ...channelBody(), unread: 0, lastSeq: 0, lastMessageAt: null, ...over });
const message = (seq: number, authorId: string, body: string, over: Record<string, unknown> = {}) => ({
  id: uuid(seq),
  seq,
  authorId,
  body,
  replyToId: null,
  createdAt: new Date(Date.UTC(2026, 9, seq <= 3 ? 9 : 10, 9, seq)).toISOString(),
  deleted: false,
  ...over,
});

/** What the stubs answer right now; a test changes a field and reloads to show another state. */
type World = {
  inbox: { status?: number; body?: unknown };
  channel: Record<string, unknown>;
  lookup: { status: number; body?: unknown };
  join: { status: number; body?: unknown };
  history: unknown[];
  sendStatus: number;
  sendBody?: unknown;
  syncBody: unknown[];
};

async function stubChat(page: Page, world: World) {
  // The stream is a finite body here: a long `retry:` keeps the browser from reconnecting (and so from re-sending "Not sent" bubbles).
  await stubHubStream(page, ['retry: 3600000\n\n', ': ready\n\n']);
  await stubApi(page, 'GET', '/chat/channels/mine', () => ({ status: world.inbox.status ?? 200, body: world.inbox.body }));
  await stubApi(page, 'GET', /^\/api\/chat\/channels\/by-product\/[^/]+$/, () => ({ status: world.lookup.status, body: world.lookup.body }));
  await stubApi(page, 'POST', /^\/api\/chat\/channels\/[0-9a-f-]{36}\/join$/, () => ({ status: world.join.status, body: world.join.body }));
  await stubApi(page, 'GET', /^\/api\/chat\/channels\/[0-9a-f-]{36}$/, () => ({ body: world.channel }));
  await stubApi(page, 'GET', /^\/api\/chat\/channels\/[0-9a-f-]{36}\/messages$/, () => ({ body: { items: [...world.history].reverse(), nextCursor: null } }));
  await stubApi(page, 'GET', /^\/api\/chat\/channels\/[0-9a-f-]{36}\/receipts$/, { body: { items: [], suppressed: false } });
  await stubApi(page, 'GET', '/chat/presence', { body: {} });
  await stubApi(page, 'POST', '/chat/presence/heartbeat', { status: 204 });
  await stubApi(page, 'POST', '/chat/sync', () => ({ body: world.syncBody }));
  await page.route(
    (url) => /^\/api\/chat\/channels\/[0-9a-f-]{36}\/messages$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (world.sendStatus === 0) return route.abort('connectionfailed');
      const status = world.sendStatus;
      await route.fulfill({
        status,
        headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
        body: JSON.stringify(world.sendBody ?? {}),
      });
    },
  );
}

const newWorld = (): World => ({
  inbox: { body: { items: [], nextCursor: null } },
  channel: channelBody(),
  lookup: { status: 200, body: channelBody() },
  join: { status: 200, body: channelBody() },
  history: [],
  sendStatus: 201,
  syncBody: [],
});

async function show(page: Page, address: string) {
  await page.goto(address);
}

const main = (page: Page) => page.locator('#main-content');

/** The virtualised list settles a few pixels apart between runs while rows are measured: states that follow the newest message pin the view to the end first. */
async function pinToEnd(page: Page) {
  const scroller = page.locator('[data-virtuoso-scroller="true"]');
  let previous = -1;
  await expect
    .poll(async () => {
      const top = await scroller.evaluate((el) => {
        el.scrollTo({ top: el.scrollHeight });
        return el.scrollTop;
      });
      const settled = top === previous;
      previous = top;
      return settled;
    })
    .toBe(true);
}

async function check(page: Page, name: string, options: { atEnd?: boolean } = {}) {
  if (options.atEnd) await pinToEnd(page);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await expectNoSeriousViolations(page);
  await expect(main(page)).toHaveScreenshot(`${name}.png`, { mask: [page.locator('time')], stylePath });
}

/** The registered member's id, so their messages read "You". */
async function memberId(page: Page): Promise<string> {
  return page.evaluate(async () => ((await (await fetch('/api/bff/session')).json()) as { user: { id: string } }).user.id);
}

/** The first inbox page is read on the server and cannot be stubbed here: make the browser read it again, now through the stub. */
const refreshInbox = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 800 } : { width: 1280, height: 800 });
});

test.describe('Chat layouts', () => {
  test('opening a chat from a product: no chat yet, and a refusal', async ({ page }) => {
    const world = newWorld();
    await register(page);
    await stubChat(page, world);

    world.lookup = { status: 404, body: { type: 'about:blank', title: 'x', status: 404, code: 'channel_not_found' } };
    await show(page, `/chat?product=${PRODUCT}`);
    await expect(page.getByText("The seller hasn't opened a chat for this product yet.")).toBeVisible();
    await check(page, 'no-chat');

    world.lookup = { status: 200, body: channelBody({ myRole: null }) };
    world.join = { status: 403, body: { type: 'about:blank', title: 'x', status: 403, code: 'banned' } };
    await show(page, `/chat?product=${PRODUCT}`);
    await expect(main(page).getByRole('alert')).toContainText("You can't join this chat.");
    await check(page, 'alert');
  });

  test('the list of chats: empty, with badges', async ({ page }) => {
    const world = newWorld();
    await register(page);
    await stubChat(page, world);

    await show(page, '/chat');
    await expect(page.getByText('No chats yet. Open a product and press Chat with seller.')).toBeVisible();
    await check(page, 'inbox-empty');

    world.inbox = {
      body: {
        items: [
          inboxItem({ unread: 3, lastSeq: 9, lastMessageAt: '2026-10-10T09:30:00.000Z' }),
          inboxItem({ id: SECOND, title: 'Desk Lamp, brass', unread: 150, lastSeq: 40, lastMessageAt: '2026-10-09T18:00:00.000Z' }),
          inboxItem({ id: THIRD, title: 'Old Chair', unread: 0, isArchived: true, lastSeq: 4, lastMessageAt: '2026-09-01T10:00:00.000Z' }),
        ],
        nextCursor: null,
      },
    };
    await refreshInbox(page);
    await expect(page.getByText('3 unread messages')).toBeVisible();
    await expect(page.getByText('99+')).toBeVisible();
    await check(page, 'inbox');
  });

  test('the list of chats while loading and when it cannot be read', async ({ page }) => {
    const world = newWorld();
    await register(page);
    await stubChat(page, world);

    // The server reads the first inbox page and hands it over, so a direct visit never shows the browser's own first read. To see
    // those states the page is reached by an in-app navigation, and the server's answer (the RSC payload) is served without that
    // page: its key is renamed (same length: the payload is length-prefixed), the browser asks, and the stub answers slowly or badly.
    await page.route(
      (url) => url.pathname === '/chat',
      async (route) => {
        if (route.request().headers()['rsc'] !== '1') return route.fallback();
        const response = await route.fetch();
        const payload = (await response.text()).replace(/(chat[\\"]+,[\\"]+)inbox/g, '$1inb0x');
        await route.fulfill({ response, body: payload });
      },
    );
    const goToChats = async () => {
      await page.goto('/');
      await page.locator('a[href="/chat"]').first().click();
    };

    let answer!: () => void;
    const gate = new Promise<void>((resolve) => (answer = resolve));
    let held = true;
    await page.route(
      (url) => url.pathname === '/api/chat/channels/mine',
      async (route) => {
        if (held) await gate;
        await route.fallback();
      },
    );
    await goToChats();
    await expect(page.getByText('Loading chats…', { exact: true })).toBeAttached();
    await check(page, 'inbox-skeleton');
    held = false;
    answer();

    world.inbox = { status: 500, body: { type: 'about:blank', title: 'x', status: 500, code: 'internal', requestId: 'req-visual-1' } };
    await goToChats();
    await expect(page.getByText("We couldn't load your chats.")).toBeVisible();
    await check(page, 'inbox-error');
  });

  test('a conversation: unread divider, counter, not sent, muted, archived', async ({ page }) => {
    const world = newWorld();
    await register(page);
    const me = await memberId(page);
    await stubChat(page, world);
    world.history = [
      message(1, SELLER, 'Hello! Thanks for your interest in the Espresso Machine.'),
      message(2, me, 'Is it still available? **Could** you ship <b>tomorrow</b>?'),
      message(3, SELLER, 'Yes, it is in stock.'),
      message(4, OTHER, 'I would like one as well.'),
      message(5, SELLER, 'Ships tomorrow morning, with a 2 year warranty.'),
    ];
    world.inbox = { body: { items: [inboxItem({ unread: 2, lastSeq: 5, lastMessageAt: '2026-10-10T09:05:00.000Z' })], nextCursor: null } };

    await show(page, `/chat?channel=${CHANNEL}`);
    await refreshInbox(page);
    await expect(page.getByTestId('chat-title')).toHaveText('Espresso Machine Titanium');
    await expect(page.getByRole('list', { name: 'Messages in Espresso Machine Titanium' })).toBeVisible();
    await expect(page.getByTestId('chat-message')).toHaveCount(5);
    await check(page, 'conversation');

    const field = page.getByRole('textbox', { name: 'Message' });
    await field.fill('x'.repeat(3700));
    await expect(page.getByText('3,700 / 4,000')).toBeVisible();
    await check(page, 'composer-counter');

    world.sendStatus = 0;
    await field.fill('Can I collect it on Friday?');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Not sent')).toBeVisible();
    await check(page, 'not-sent', { atEnd: true });
    // (A network failure is retried by itself when the connection returns: settle this bubble before the next state.)
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText('Not sent')).toHaveCount(0);

    world.sendStatus = 403;
    world.sendBody = { type: 'about:blank', title: 'x', status: 403, code: 'muted', mutedUntil: '2099-01-01T12:00:00.000Z' };
    await field.fill('Hello again');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText(/You're muted until/)).toBeVisible();
    await check(page, 'muted', { atEnd: true });

    world.channel = channelBody({ isArchived: true, archivedAt: '2026-10-11T10:00:00.000Z' });
    await show(page, `/chat?channel=${CHANNEL}`);
    await expect(page.getByText('This chat was archived. You can read it, but not reply.')).toBeVisible();
    await check(page, 'archived');
  });

  test('the connection banner and the jump pill', async ({ page }) => {
    const world = newWorld();
    await register(page);
    const me = await memberId(page);
    await stubChat(page, world);
    world.history = Array.from({ length: 40 }, (_, index) => message(index + 1, index % 3 === 0 ? me : SELLER, `Message number ${index + 1} in a long conversation.`));
    world.inbox = { body: { items: [inboxItem({ unread: 0, lastSeq: 40, lastMessageAt: '2026-10-10T09:40:00.000Z' })], nextCursor: null } };

    // The reader is up in the history when someone writes: the view stays, and a pill says how many are waiting.
    await show(page, `/chat?channel=${CHANNEL}`);
    const list = page.getByTestId('message-list');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('chat-message').last()).toBeVisible();
    await list.locator('[data-virtuoso-scroller="true"]').evaluate((scroller) => scroller.scrollTo({ top: 0 }));
    await expect(page.getByText('Start of the chat')).toBeVisible();
    world.syncBody = [{ channelId: CHANNEL, messages: [message(41, SELLER, 'A new message while you were reading up here.')], lastSeq: 41, hasMore: false }];
    await expect(page.getByText('Message number 40 in a long conversation.')).not.toBeInViewport();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('button', { name: 'Jump to latest, 1 new message' })).toBeVisible();
    await check(page, 'pill');

    // The browser goes offline: the banner says so, at the top of the inbox and the conversation.
    await page.context().setOffline(true);
    await expect(page.getByText("You're offline. Messages will send when you're back online.")).toBeVisible();
    await check(page, 'offline');
    await page.context().setOffline(false);
  });

  test('the live connection is lost: the reconnecting banner', async ({ page }) => {
    const world = newWorld();
    await register(page);
    await stubChat(page, world);
    world.history = [message(1, SELLER, 'Hello!')];
    world.inbox = { body: { items: [inboxItem({ lastSeq: 1, lastMessageAt: '2026-10-10T09:01:00.000Z' })], nextCursor: null } };
    // A stream that opens and is then cut: the browser keeps trying, and the page says "Reconnecting…" after 3 seconds.
    await page.route(
      (url) => url.pathname === '/api/streams',
      (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }, body: 'retry: 600000\n\n' }),
    );
    await show(page, `/chat?channel=${CHANNEL}`);
    await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 });
    await check(page, 'reconnecting');
  });
});
