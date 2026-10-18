import { screen, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { chatClient, inboxItem, inboxPage, problemBody, renderChat, mockChatRoutes } from '@/tests/support/chat-fixtures';
import { ChatNavBadge, useChatUnreadTotal } from './chat-nav-badge';

describe('Chat nav badge', () => {
  it('W05 AS-11: shows the total of the unread badges of the first inbox page', async () => {
    mockChatRoutes({ inbox: () => inboxPage([inboxItem({ unread: 2 }), inboxItem({ unread: 3 })]) });
    renderChat(<ChatNavBadge />);
    expect(await screen.findByText('5 unread messages')).toBeInTheDocument();
    expect(screen.getByText('5')).toHaveAttribute('aria-hidden', 'true');
  });

  it('W05 AS-11: shows 99+ above 99', async () => {
    mockChatRoutes({ inbox: () => inboxPage([inboxItem({ unread: 60 }), inboxItem({ unread: 60 })]) });
    renderChat(<ChatNavBadge />);
    expect(await screen.findByText('99+')).toBeInTheDocument();
    expect(screen.getByText('120 unread messages')).toBeInTheDocument();
  });

  it('W05 AS-11: shows nothing for 0 unread', async () => {
    const calls = mockChatRoutes({ inbox: () => inboxPage([inboxItem({ unread: 0 })]) });
    const { container } = renderChat(<ChatNavBadge />);
    await waitFor(() => expect(calls.inbox).toBe(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('W05 AS-11: shows nothing while unknown and when the read fails', async () => {
    const calls = mockChatRoutes({ inbox: () => problemBody(500, 'internal') });
    const { container } = renderChat(<ChatNavBadge />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(calls.inbox).toBe(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('W05 AS-11: an anonymous visitor gets nothing and no request is made', async () => {
    const calls = mockChatRoutes({ inbox: () => inboxPage([inboxItem({ unread: 4 })]) });
    const { container } = renderChat(<ChatNavBadge />, { user: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
    expect(calls.inbox).toBe(0);
  });

  it('W05 AS-11: useChatUnreadTotal is null while unknown or anonymous and the number once known', async () => {
    mockChatRoutes({ inbox: () => inboxPage([inboxItem({ unread: 7 })]) });
    const client = chatClient();
    const { result } = renderHook(() => useChatUnreadTotal(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(7));
  });
});
