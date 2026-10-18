import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CH1, channel, ORIGIN, PRODUCT, problemBody, renderChat, type Role } from '@/tests/support/chat-fixtures';
import { server } from '../../vitest.setup';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));

import { ProductChatResolver } from './product-chat-resolver';

const byProduct = `${ORIGIN}/api/chat/channels/by-product/${PRODUCT}`;
const join = `${ORIGIN}/api/chat/channels/${CH1}/join`;
const create = `${ORIGIN}/api/chat/channels`;

function setup(role: Role = 'USER') {
  const onResolved = vi.fn();
  const view = renderChat(<ProductChatResolver productId={PRODUCT} onResolved={onResolved} />, { user: { role } });
  return { onResolved, ...view };
}

beforeEach(() => replace.mockReset());
afterEach(() => vi.useRealTimers());

describe('Product chat resolver', () => {
  it('W05 AS-01: shows "Opening chat…" as a status, looks the chat up, joins it, then replaces the address with ?channel=', async () => {
    const calls: string[] = [];
    server.use(
      http.get(byProduct, () => {
        calls.push('lookup');
        return HttpResponse.json(channel({ myRole: null }));
      }),
      http.post(join, () => {
        calls.push('join');
        return HttpResponse.json(channel({ myRole: 'MEMBER' }));
      }),
    );
    const { onResolved } = setup();
    expect(screen.getByRole('status')).toHaveTextContent('Opening chat…');
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/chat?channel=${CH1}`));
    expect(calls).toEqual(['lookup', 'join']);
    expect(onResolved).toHaveBeenCalledWith(CH1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-02: a member who is already ACTIVE opens the chat without a join request', async () => {
    const joined = vi.fn();
    server.use(
      http.get(byProduct, () => HttpResponse.json(channel({ myRole: 'MEMBER' }))),
      http.post(join, () => {
        joined();
        return HttpResponse.json(channel());
      }),
    );
    setup();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/chat?channel=${CH1}`));
    expect(joined).not.toHaveBeenCalled();
  });

  it('W05 AS-03: no chat yet, a buyer sees the explanation and a Back to product link, and no create button', async () => {
    const created = vi.fn();
    server.use(
      http.get(byProduct, () => problemBody(404, 'channel_not_found')),
      http.post(create, () => {
        created();
        return HttpResponse.json(channel());
      }),
    );
    setup('USER');
    expect(await screen.findByText("The seller hasn't opened a chat for this product yet.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to product' })).toHaveAttribute('href', `/products/${PRODUCT}`);
    expect(screen.queryByRole('button', { name: 'Open chat for this product' })).not.toBeInTheDocument();
    expect(created).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each<Role>(['SELLER', 'ADMIN'])('W05 AS-04: a %s sees "Open chat for this product", which creates the chat and opens it without a join', async (role) => {
    const joined = vi.fn();
    server.use(
      http.get(byProduct, () => problemBody(404, 'channel_not_found')),
      http.post(create, async ({ request }) => {
        expect(await request.json()).toEqual({ productId: PRODUCT });
        return HttpResponse.json(channel({ myRole: 'OWNER' }), { status: 201 });
      }),
      http.post(join, () => {
        joined();
        return HttpResponse.json(channel());
      }),
    );
    const { onResolved } = setup(role);
    await userEvent.click(await screen.findByRole('button', { name: 'Open chat for this product' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/chat?channel=${CH1}`));
    expect(onResolved).toHaveBeenCalledWith(CH1);
    expect(joined).not.toHaveBeenCalled();
  });

  it('W05 AS-04: while the chat is being created the button is disabled with a spinner', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get(byProduct, () => problemBody(404, 'channel_not_found')),
      http.post(create, async () => {
        await gate;
        return HttpResponse.json(channel({ myRole: 'OWNER' }), { status: 201 });
      }),
    );
    setup('SELLER');
    await userEvent.click(await screen.findByRole('button', { name: 'Open chat for this product' }));
    const busy = screen.getByRole('button', { name: 'Open chat for this product' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    await act(async () => release());
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });

  it('W05 AS-04: 403 permission_denied explains who can open the chat and the button returns', async () => {
    server.use(http.get(byProduct, () => problemBody(404, 'channel_not_found')), http.post(create, () => problemBody(403, 'permission_denied')));
    setup('SELLER');
    await userEvent.click(await screen.findByRole('button', { name: 'Open chat for this product' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Only staff of this product's shop can open its chat.");
    expect(screen.getByRole('button', { name: 'Open chat for this product' })).toBeEnabled();
  });

  it('W05 AS-04: 409 channel_exists runs the lookup again and opens the chat that was created meanwhile', async () => {
    let lookups = 0;
    server.use(
      http.get(byProduct, () => {
        lookups += 1;
        return lookups === 1 ? problemBody(404, 'channel_not_found') : HttpResponse.json(channel({ myRole: 'OWNER' }));
      }),
      http.post(create, () => problemBody(409, 'channel_exists')),
    );
    setup('SELLER');
    await userEvent.click(await screen.findByRole('button', { name: 'Open chat for this product' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/chat?channel=${CH1}`));
    expect(lookups).toBe(2);
  });

  it('W05 AS-04: 404 product_not_found on create shows the invalid-link copy', async () => {
    server.use(http.get(byProduct, () => problemBody(404, 'channel_not_found')), http.post(create, () => problemBody(404, 'product_not_found')));
    setup('ADMIN');
    await userEvent.click(await screen.findByRole('button', { name: 'Open chat for this product' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This product link isn't valid.");
  });

  type Case = { name: string; step: 'lookup' | 'join'; status: number; code: string; text: string; link?: [string, string]; reference?: boolean; retry?: boolean };
  const cases: Case[] = [
    { name: '400 validation_failed', step: 'lookup', status: 400, code: 'validation_failed', text: "This product link isn't valid.", link: ['Browse products', '/search'] },
    { name: '404 product_not_found', step: 'lookup', status: 404, code: 'product_not_found', text: "This product link isn't valid.", link: ['Browse products', '/search'] },
    { name: '409 channel_archived on join', step: 'join', status: 409, code: 'channel_archived', text: "This chat was archived and isn't accepting new members.", link: ['Back to product', `/products/${PRODUCT}`] },
    { name: '403 banned on join', step: 'join', status: 403, code: 'banned', text: "You can't join this chat." },
    { name: '5xx on lookup', step: 'lookup', status: 503, code: 'service_unavailable', text: "We couldn't open this chat.", reference: true, retry: true },
    { name: '5xx on join', step: 'join', status: 500, code: 'internal', text: "We couldn't open this chat.", reference: true, retry: true },
  ];

  it.each(cases)('W05 AS-05: $name is one alert with the specific copy and a way out', async (c) => {
    server.use(
      http.get(byProduct, () => (c.step === 'lookup' ? problemBody(c.status, c.code) : HttpResponse.json(channel({ myRole: null })))),
      http.post(join, () => problemBody(c.status, c.code)),
    );
    setup();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(c.text);
    if (c.reference) expect(alert).toHaveTextContent('Reference: req-1');
    if (c.link) expect(screen.getByRole('link', { name: c.link[0] })).toHaveAttribute('href', c.link[1]);
    expect(Boolean(screen.queryByRole('button', { name: 'Try again' }))).toBe(Boolean(c.retry));
    expect(alert.textContent).not.toMatch(/Server (title|detail)/);
    expect(replace).not.toHaveBeenCalled();
  });

  it('W05 AS-05: Try again repeats the failed step and opens the chat', async () => {
    let tries = 0;
    server.use(
      http.get(byProduct, () => {
        tries += 1;
        return tries === 1 ? problemBody(503, 'service_unavailable') : HttpResponse.json(channel({ myRole: 'MEMBER' }));
      }),
    );
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/chat?channel=${CH1}`));
  });

  it('W05 AS-05: 429 shows the wait and enables Try again only when the wait ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.use(http.get(byProduct, () => problemBody(429, 'rate_limited', {}, { 'retry-after': '30' })));
    setup();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Try again in 30 seconds.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});
