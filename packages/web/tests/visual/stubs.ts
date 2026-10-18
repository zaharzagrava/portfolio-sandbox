import type { Page, Route } from '@playwright/test';

/**
 * W05 visual-suite stubs (gap T3): the backend answers layout fixtures through `page.route`, so a screenshot shows a layout
 * state and never depends on seeded data or timing. Behaviour is proven by the unit tests, not here. Page requests the
 * server makes itself (the Server Component's first inbox read) cannot be stubbed in the browser; the specs that need a
 * member use a real registered user and stub only the browser's own `/api/**` calls.
 */

type Json = unknown;
type Reply = { status?: number; body?: Json; headers?: Record<string, string>; delayMs?: number };

const jsonHeaders = { 'content-type': 'application/json' };

async function fulfil(route: Route, reply: Reply) {
  if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
  const status = reply.status ?? 200;
  await route.fulfill({
    status,
    headers: { ...(status >= 400 ? { 'content-type': 'application/problem+json' } : jsonHeaders), ...reply.headers },
    body: status === 204 || reply.body === undefined ? '' : JSON.stringify(reply.body),
  });
}

/** Answer `METHOD /api<path>` (a string path or a RegExp on the pathname) with a fixed reply. Returns the call count reader. */
export async function stubApi(page: Page, method: string, path: string | RegExp, reply: Reply | ((url: URL) => Reply)): Promise<() => number> {
  let calls = 0;
  await page.route(
    (url) => (typeof path === 'string' ? url.pathname === `/api${path}` : path.test(url.pathname)),
    async (route) => {
      if (route.request().method() !== method.toUpperCase()) return route.fallback();
      calls += 1;
      const url = new URL(route.request().url());
      await fulfil(route, typeof reply === 'function' ? reply(url) : reply);
    },
  );
  return () => calls;
}

/** A problem+json answer in the platform's shape. */
export const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Reply => ({
  status,
  body: { type: 'about:blank', title: code, status, code, ...extra },
});

/** A server-sent stream whose frames arrive at once and whose connection then stays idle (layout of a streaming state). */
export async function stubEventStream(page: Page, path: string | RegExp, frames: string[], method = 'POST') {
  await page.route(
    (url) => (typeof path === 'string' ? url.pathname === `/api${path}` : path.test(url.pathname)),
    async (route) => {
      if (route.request().method() !== method.toUpperCase()) return route.fallback();
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' },
        body: frames.join(''),
      });
    },
  );
}

/** One SSE frame for `stubEventStream`. */
export const frame = (event: string, data: unknown, id?: string) => `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The shared hub stream (`/api/streams`): stays open without frames, so the page reads as connected and idle. */
export async function stubHubStream(page: Page, frames: string[] = [': ready\n\n']) {
  await page.route(
    (url) => url.pathname === '/api/streams',
    (route) =>
      route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' }, body: frames.join('') }),
  );
}

/** The browser goes offline/online (the offline banner state). */
export const setOffline = (page: Page, offline: boolean) => page.context().setOffline(offline);
