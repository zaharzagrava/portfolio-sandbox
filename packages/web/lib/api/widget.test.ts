import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { widgetIdentifySchema } from '@marketplace-sandbox/contracts';
import { identify, readIdentified } from './widget';

const KEY = 'pk_live_abcdefghijklmnopqrstuvwx';

describe('W07 widget identify shape (AS-40)', () => {
  it.each([
    [{ widgetToken: 'w.t', expiresIn: 900, customer: { id: 'c', email: 'a@b.c' } }],
    [{ widgetToken: 'w.t', expiresIn: 900, customer: { id: 'c', email: null } }],
    [{ widgetToken: '', expiresIn: 900, customer: { id: 'c', email: null } }],
    [{ widgetToken: 'w.t', expiresIn: 900, customer: { id: 7, email: null } }],
    [{ widgetToken: 'w.t', expiresIn: 900, customer: { id: 'c' } }],
    [{ widgetToken: 'w.t', expiresIn: 900 }],
    [{ widgetToken: 5, expiresIn: 900, customer: { id: 'c', email: null } }],
    [null],
    ['text'],
  ])('W07 AS-40: the hand-written check agrees with the contract schema on %j', (body) => {
    expect(readIdentified(body) !== null).toBe(widgetIdentifySchema.safeParse(body).success);
  });
});

describe('W07 widget identify call (AS-40)', () => {
  it('W07 AS-40: posts {key, token} to the same-origin identify route without credentials and returns the customer', async () => {
    let seen: { url: string; body: unknown } | undefined;
    server.use(
      http.post('*/api/widget/v1/identify', async ({ request }) => {
        seen = { url: new URL(request.url).pathname, body: await request.json() };
        return HttpResponse.json({ widgetToken: 'w.t', expiresIn: 900, customer: { id: 'cust-42', email: 'buyer@example.com' } });
      }),
    );
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = await identify(KEY, 'handoff');
    expect(result).toEqual({ ok: true, widgetToken: 'w.t', customer: { id: 'cust-42', email: 'buyer@example.com' } });
    expect(seen).toEqual({ url: '/api/widget/v1/identify', body: { key: KEY, token: 'handoff' } });
    expect(spy.mock.calls[0][0]).toBe('/api/widget/v1/identify');
    expect(spy.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'omit' });
    spy.mockRestore();
  });

  it.each([[422], [410], [403], [404], [401], [503]])('W07 AS-40: a %i answer is a failure carrying only its status', async (status) => {
    server.use(http.post('*/api/widget/v1/identify', () => HttpResponse.json({ status, code: 'whatever', detail: 'secret detail' }, { status })));
    expect(await identify(KEY, 'handoff')).toEqual({ ok: false, status });
  });

  it('W07 AS-40: a body that is not an identification result, and a network failure, are failures', async () => {
    server.use(http.post('*/api/widget/v1/identify', () => HttpResponse.json({ hello: 'world' })));
    expect(await identify(KEY, 'handoff')).toEqual({ ok: false, status: 502 });
    server.use(http.post('*/api/widget/v1/identify', () => HttpResponse.error()));
    expect(await identify(KEY, 'handoff')).toEqual({ ok: false, status: 0 });
  });
});
