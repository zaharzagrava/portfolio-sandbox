import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../vitest.setup';
import { UnsubscribeConfirm } from './unsubscribe-confirm';

const origin = 'http://localhost:3000';
const TOKEN = 'secret-token-value.mac';

function show() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <UnsubscribeConfirm token={TOKEN} category="orders" />
    </QueryClientProvider>,
  );
}

describe('UnsubscribeConfirm', () => {
  it('S28 AS-25: it describes the change first and posts only when the button is pressed', async () => {
    const posts: string[] = [];
    server.use(
      http.post(`${origin}/api/notifications/unsubscribe`, ({ request }) => {
        posts.push(new URL(request.url).searchParams.get('token') ?? '');
        return HttpResponse.json({ unsubscribed: 'orders' });
      }),
    );
    show();
    expect(screen.getByText(/Stop receiving/)).toHaveTextContent('orders');
    expect(posts).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByRole('status')).toHaveTextContent('You are unsubscribed from orders emails.');
    expect(posts).toEqual([TOKEN]);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('S28 AS-26: 400 invalid_unsubscribe_token becomes a friendly "link is not valid" state without the token', async () => {
    server.use(http.post(`${origin}/api/notifications/unsubscribe`, () => HttpResponse.json({ code: 'invalid_unsubscribe_token' }, { status: 400 })));
    show();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This unsubscribe link is not valid.');
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('S28 AS-26: 429 says when to try again and keeps the button', async () => {
    server.use(http.post(`${origin}/api/notifications/unsubscribe`, () => HttpResponse.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '20' } })));
    show();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 20 seconds.');
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeEnabled();
  });
});
