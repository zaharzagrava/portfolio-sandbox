import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionPresence } from '@/lib/api/session-presence';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { queryKeys } from '@/lib/query-keys';
import { CH1, CH2, ME, ORIGIN, PRODUCT, channel, chatClient, historyPage, inboxItem, inboxPage, message, mockChatRoutes, problemBody, renderChat } from '@/tests/support/chat-fixtures';
import { server } from '../../vitest.setup';

const requireServerSession = vi.fn();
vi.mock('@/lib/auth/session.server', () => ({ requireServerSession: (returnTo: string) => requireServerSession(returnTo) }));
vi.mock('@/lib/server/chat.server', () => ({ getInboxPage: vi.fn(async () => ({ ok: false, status: 0 })) }));

const navigation = vi.hoisted(() => ({ search: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => navigation.search,
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));

import ChatPage from '@/app/chat/page';
import { ChatShell } from './chat-shell';

/** Runs the server component the page renders inside `<Suspense>` (the request reads live there, AS-69). */
async function renderGuarded(searchParams: Record<string, string | string[] | undefined>) {
  const page = ChatPage({ searchParams: Promise.resolve(searchParams) }) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
  expect(isValidElement(page)).toBe(true);
  const guarded = page.props.children;
  const component = guarded.type as (props: Record<string, unknown>) => Promise<unknown>;
  return component(guarded.props);
}

beforeEach(() => {
  requireServerSession.mockReset();
  navigation.search = new URLSearchParams();
  navigation.replace.mockReset();
});

describe('Chat page (guards, panes, keyboard, session end)', () => {
  it('W05 AS-06: an anonymous visitor is sent to sign-in with the full address, including ?product=', async () => {
    requireServerSession.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(renderGuarded({ product: PRODUCT })).rejects.toThrow('NEXT_REDIRECT');
    expect(requireServerSession).toHaveBeenCalledWith(`/chat?product=${PRODUCT}`);
  });

  it('W05 AS-06: ?channel= is kept in returnTo, and a bare /chat returns to /chat', async () => {
    requireServerSession.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(renderGuarded({ channel: CH1 })).rejects.toThrow('NEXT_REDIRECT');
    expect(requireServerSession).toHaveBeenLastCalledWith(`/chat?channel=${CH1}`);
    await expect(renderGuarded({})).rejects.toThrow('NEXT_REDIRECT');
    expect(requireServerSession).toHaveBeenLastCalledWith('/chat');
  });

  it('W05 AS-06: the guard runs before any member data is read', async () => {
    const { getInboxPage } = await import('@/lib/server/chat.server');
    requireServerSession.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(renderGuarded({ channel: CH1 })).rejects.toThrow();
    expect(getInboxPage).not.toHaveBeenCalled();
  });

  it('W05 AS-69: a member gets the shell with the first inbox page handed over for hydration', async () => {
    requireServerSession.mockResolvedValue({ id: ME });
    const { getInboxPage } = await import('@/lib/server/chat.server');
    vi.mocked(getInboxPage).mockResolvedValueOnce({ ok: true, data: inboxPage([inboxItem()]) });
    const element = (await renderGuarded({})) as ReactElement<{ state: { queries: { queryKey: unknown[] }[] } }>;
    expect(element.props.state.queries.map((query) => query.queryKey)).toEqual([['chat', 'inbox']]);
  });

  it('W05 AS-69: a failed first read is left out, so no error text is cached on the server', async () => {
    requireServerSession.mockResolvedValue({ id: ME });
    const element = (await renderGuarded({})) as ReactElement<{ state: { queries: unknown[] } }>;
    expect(element.props.state.queries).toEqual([]);
  });

  describe('panes and the address', () => {
    it('W05 AS-68: ?channel= is the open chat: the conversation shows it and its inbox row is the current page, a link', async () => {
      navigation.search = new URLSearchParams({ channel: CH1 });
      const joined = vi.fn();
      server.use(
        http.post(`${ORIGIN}/api/chat/channels/${CH1}/join`, () => {
          joined();
          return HttpResponse.json(channel());
        }),
      );
      mockChatRoutes({
        inbox: () => inboxPage([inboxItem({ id: CH1, title: 'Espresso Machine' }), inboxItem({ id: CH2, title: 'Desk Lamp' })]),
        channel: () => channel({ id: CH1 }),
        history: () => historyPage([message(1)]),
      });
      renderChat(<ChatShell />, { user: { id: ME } });
      expect(await screen.findByRole('heading', { level: 1, name: 'Espresso Machine' })).toBeInTheDocument();
      const nav = screen.getByRole('navigation', { name: 'Your chats' });
      const current = await within(nav).findByRole('link', { name: /Espresso Machine/ });
      expect(current).toHaveAttribute('aria-current', 'page');
      expect(current).toHaveAttribute('href', `/chat?channel=${CH1}`);
      expect(within(nav).getByRole('link', { name: /Desk Lamp/ })).not.toHaveAttribute('aria-current');
      expect(joined).not.toHaveBeenCalled();
    });

    it('W05 AS-37: without ?channel= the pane says "Select a chat to read it." and no chat is read', async () => {
      const calls = mockChatRoutes({ inbox: () => inboxPage([inboxItem()]), channel: () => channel(), history: () => historyPage([]) });
      renderChat(<ChatShell />, { user: { id: ME } });
      expect(await screen.findByText('Select a chat to read it.')).toBeInTheDocument();
      await screen.findByRole('link', { name: /Espresso Machine/ });
      expect(calls.channel).toBe(0);
      expect(calls.history).toBe(0);
    });

    it('W05 AS-68: a malformed ?channel= shows the unavailable state without a request', async () => {
      navigation.search = new URLSearchParams({ channel: 'not-a-uuid' });
      const calls = mockChatRoutes({ inbox: () => inboxPage([]), channel: () => channel(), history: () => historyPage([]) });
      renderChat(<ChatShell />, { user: { id: ME } });
      expect(await screen.findByText("This chat isn't available.")).toBeInTheDocument();
      expect(calls.channel).toBe(0);
      expect(calls.history).toBe(0);
    });

    it('W05 AS-05: a malformed ?product= shows the invalid-link copy without a request', async () => {
      navigation.search = new URLSearchParams({ product: 'nope' });
      mockChatRoutes({ inbox: () => inboxPage([]) });
      renderChat(<ChatShell />, { user: { id: ME } });
      expect(await screen.findByRole('alert')).toHaveTextContent("This product link isn't valid.");
      expect(screen.getByRole('link', { name: 'Browse products', description: '' })).toBeTruthy();
    });

    it('W05 AS-38: opening a chat from the list moves focus to its heading, and Back to all chats returns focus to the row that was open', async () => {
      mockChatRoutes({ inbox: () => inboxPage([inboxItem({ id: CH1 }), inboxItem({ id: CH2, title: 'Desk Lamp' })]), channel: () => channel(), history: () => historyPage([message(1)]) });
      const view = renderChat(<ChatShell />, { user: { id: ME } });
      await screen.findByRole('link', { name: /Espresso Machine/ });
      navigation.search = new URLSearchParams({ channel: CH1 });
      view.rerenderChat(<ChatShell />);
      const heading = await screen.findByRole('heading', { level: 1, name: 'Espresso Machine' });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(screen.getByRole('link', { name: 'Back to all chats' })).toHaveAttribute('href', '/chat');
      navigation.search = new URLSearchParams();
      view.rerenderChat(<ChatShell />);
      await waitFor(() => expect(screen.getByRole('link', { name: /Espresso Machine/ })).toHaveFocus());
    });

    it('W05 AS-39: landmarks and names: a nav "Your chats", the conversation as a region named by its h1, a list "Messages in {title}", a form with a labelled field', async () => {
      navigation.search = new URLSearchParams({ channel: CH1 });
      mockChatRoutes({ inbox: () => inboxPage([inboxItem({ id: CH1 })]), channel: () => channel(), history: () => historyPage([message(1)]) });
      renderChat(<ChatShell />, { user: { id: ME } });
      await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
      expect(screen.getByRole('navigation', { name: 'Your chats' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Espresso Machine' })).toBeInTheDocument();
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByRole('form', { name: 'Write a message' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    });

    it('W05 AS-39: tab order runs inbox rows, Show more chats, the header links, Load earlier messages, each Message actions button, then the field', async () => {
      navigation.search = new URLSearchParams({ channel: CH1 });
      mockChatRoutes({
        inbox: () => inboxPage([inboxItem({ id: CH1 })], 'more'),
        channel: () => channel(),
        history: () => historyPage([message(1), message(2)], 'older'),
      });
      renderChat(<ChatShell />, { user: { id: ME } });
      await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
      await screen.findByRole('button', { name: 'Show more chats' });
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled());
      const order: string[] = [];
      for (let step = 0; step < 8; step++) {
        await userEvent.tab();
        const active = document.activeElement as HTMLElement;
        order.push(active.tagName === 'TEXTAREA' ? 'field' : (active.getAttribute('aria-label') ?? active.textContent?.trim() ?? ''));
      }
      expect(order[0]).toContain('Espresso Machine');
      expect(order.slice(1, 5)).toEqual(['Show more chats', 'Back to all chats', 'View product', 'Load earlier messages']);
      expect(order[5]).toMatch(/^Message actions for the message from Seller at /);
      expect(order[6]).toMatch(/^Message actions for the message from Seller at /);
      expect(order[7]).toBe('field');
    });

    it('W05 AS-39: nothing announces the whole list: it is not a live region, and there is no log role', async () => {
      navigation.search = new URLSearchParams({ channel: CH1 });
      mockChatRoutes({ inbox: () => inboxPage([inboxItem({ id: CH1 })]), channel: () => channel(), history: () => historyPage([message(1)]) });
      renderChat(<ChatShell />, { user: { id: ME } });
      const list = await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
      expect(list.closest('[aria-live]')).toBeNull();
      expect(screen.queryByRole('log')).not.toBeInTheDocument();
      expect(screen.getAllByRole('status').length).toBeGreaterThanOrEqual(2);
    });

    it('W05 AS-40: a 401 on chat requests runs the session-ended flow once', async () => {
      const ended = vi.fn();
      setSessionEndHandler(ended);
      navigation.search = new URLSearchParams({ channel: CH1 });
      mockChatRoutes({
        inbox: () => problemBody(401, 'unauthenticated'),
        channel: () => problemBody(401, 'unauthenticated'),
        history: () => problemBody(401, 'unauthenticated'),
      });
      const client = chatClient({ id: ME });
      setSessionPresence(() => true);
      renderChat(<ChatShell />, { client });
      await waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ended).toHaveBeenCalledTimes(1);
      setSessionEndHandler(null);
      rearmSessionEnd();
    });

    it('W05 AS-40: when the session is gone the drafts and "Not sent" bubbles are dropped and nothing of the chats stays on screen', async () => {
      navigation.search = new URLSearchParams({ channel: CH1 });
      mockChatRoutes({ inbox: () => inboxPage([inboxItem({ id: CH1 })]), channel: () => channel(), history: () => historyPage([message(1)]) });
      server.use(http.post(`${ORIGIN}/api/chat/channels/${CH1}/messages`, () => HttpResponse.error()));
      const client = chatClient({ id: ME });
      renderChat(<ChatShell />, { client });
      await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled());
      await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'lost one{Enter}');
      await screen.findByText('Not sent');
      await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'half typed');
      act(() => {
        client.setQueryData(queryKeys.auth.session(), null);
      });
      await waitFor(() => expect(screen.queryByText('Not sent')).not.toBeInTheDocument());
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByText('Espresso Machine')).not.toBeInTheDocument();
    });

    it('W05 AS-40: a chat that answers 403 or 404 a moment after it was readable shows the unavailable state, and nothing from the cache for it', async () => {
      navigation.search = new URLSearchParams({ channel: CH1 });
      const client = chatClient({ id: ME });
      // Cached a while ago (stale), so the page reads them again when it opens.
      client.setQueryData(queryKeys.chat.channel(CH1), channel(), { updatedAt: 1 });
      client.setQueryData(queryKeys.chat.messages(CH1), { pages: [historyPage([message(1, { body: 'cached secret' })])], pageParams: [undefined] }, { updatedAt: 1 });
      client.setQueryData(queryKeys.chat.inbox(), { pages: [inboxPage([inboxItem({ id: CH1 })])], pageParams: [undefined] });
      mockChatRoutes({ inbox: () => inboxPage([inboxItem({ id: CH1 })]), channel: () => problemBody(404, 'channel_not_found'), history: () => problemBody(404, 'channel_not_found') });
      renderChat(<ChatShell />, { client });
      expect(await screen.findByText("This chat isn't available.")).toBeInTheDocument();
      expect(screen.queryByText('cached secret')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('W05 AS-01: ?product= runs the resolver, which replaces the address by ?channel= and the conversation then focuses the message field', async () => {
      navigation.search = new URLSearchParams({ product: PRODUCT });
      server.use(http.get(`${ORIGIN}/api/chat/channels/by-product/${PRODUCT}`, () => HttpResponse.json(channel({ id: CH1, myRole: 'MEMBER' }))));
      mockChatRoutes({ inbox: () => inboxPage([inboxItem()]), channel: () => channel(), history: () => historyPage([message(1)]) });
      const view = renderChat(<ChatShell />, { user: { id: ME } });
      await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(`/chat?channel=${CH1}`));
      // The address changes: the shell re-reads it and opens the conversation, entering through the field.
      navigation.search = new URLSearchParams({ channel: CH1 });
      view.rerenderChat(<ChatShell />);
      expect(await screen.findByRole('heading', { level: 1, name: 'Espresso Machine' })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus());
    });
  });
});
