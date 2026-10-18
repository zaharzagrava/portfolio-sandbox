import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DONE, META, TEXT } from '../../tests/support/fake-assistant';
import { queryKeys } from '@/lib/query-keys';

const fake = await vi.hoisted(async () => (await import('../../tests/support/fake-assistant')).createFakeAssistant());
const auth = vi.hoisted(() => ({ value: { user: { id: 'u1', email: 'a@b.c', role: 'USER' } as { id: string; email: string; role: string } | null, status: 'authenticated' as string } }));
const authBus = vi.hoisted(() => ({ handlers: new Set<(type: 'signed-in' | 'signed-out') => void>() }));
const nav = vi.hoisted(() => ({ pathname: '/search' }));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ ...auth.value, isAuthenticated: auth.value.user !== null, isLoading: auth.value.status === 'loading' }),
}));
vi.mock('@/lib/auth/session-sync', () => ({
  subscribeAuth: (handler: (type: 'signed-in' | 'signed-out') => void) => {
    authBus.handlers.add(handler);
    return () => void authBus.handlers.delete(handler);
  },
  announceAuth: vi.fn(),
}));
vi.mock('@/lib/api/assistant', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api/assistant')>()), assistantApi: fake.api }));

import { ACTIVE_KEY, SHEET_OPEN_KEY, saveActive } from '@/lib/assistant/active-store';
import { AssistantLauncher, setAssistantSheetOpen } from './assistant-launcher';

let client: QueryClient;
function renderLauncher(extra: React.ReactNode = null) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <button type="button">Outside</button>
      <AssistantLauncher variant="icon" />
      {extra}
    </QueryClientProvider>,
  );
}
const launcher = () => screen.getByRole('button', { name: 'AI Assistant' });

beforeEach(() => {
  fake.reset();
  sessionStorage.clear();
  auth.value = { user: { id: 'u1', email: 'a@b.c', role: 'USER' }, status: 'authenticated' };
  nav.pathname = '/search';
  window.history.replaceState({}, '', '/search?q=phone');
  setAssistantSheetOpen(false);
});
afterEach(() => {
  setAssistantSheetOpen(false);
  authBus.handlers.clear();
});

describe('Assistant launcher', () => {
  it('W05 AS-41: the launcher opens a modal dialog named "AI Shopping Assistant" with a description', async () => {
    renderLauncher();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(launcher());
    const dialog = screen.getByRole('dialog', { name: 'AI Shopping Assistant' });
    expect(dialog).toHaveAccessibleDescription(/\S/);
  });

  it('W05 AS-41: focus moves to the message field, the page behind is inert, Esc closes and focus returns to the launcher', async () => {
    renderLauncher();
    await userEvent.click(launcher());
    expect(screen.getByRole('textbox', { name: 'Message to the assistant' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Outside' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(launcher()).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Outside' })).toBeInTheDocument();
  });

  it('W05 AS-41: the close button closes the sheet', async () => {
    renderLauncher();
    await userEvent.click(launcher());
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('W05 AS-41: the menu-item variant opens the sheet that the icon variant owns', async () => {
    renderLauncher(<AssistantLauncher variant="menu-item" />);
    const buttons = screen.getAllByRole('button', { name: 'AI Assistant' });
    await userEvent.click(buttons[1]);
    expect(screen.getByRole('dialog', { name: 'AI Shopping Assistant' })).toBeInTheDocument();
  });

  it('W05 AS-41: an anonymous visitor sees the sign-in prompt with a link back to the current address', async () => {
    auth.value = { user: null, status: 'anonymous' };
    renderLauncher();
    await userEvent.click(launcher());
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Sign in to chat with the shopping assistant.')).toBeInTheDocument();
    const link = within(dialog).getByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent('/search?q=phone')}`);
    expect(link).toHaveFocus();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  it('W05 AS-41: while the session is read there is a skeleton, and when it cannot be checked a message', async () => {
    auth.value = { user: null, status: 'loading' };
    const { unmount } = renderLauncher();
    await userEvent.click(launcher());
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveAccessibleName(/session/i);
    expect(screen.queryByRole('textbox')).toBeNull();
    unmount();
    setAssistantSheetOpen(false);

    auth.value = { user: null, status: 'unavailable' };
    renderLauncher();
    await userEvent.click(launcher());
    expect(screen.getByText("We can't check your session right now. Try again in a moment.")).toBeInTheDocument();
  });

  it('W05 AS-41: a member with no conversation sees the empty state and the composer', async () => {
    renderLauncher();
    await userEvent.click(launcher());
    expect(screen.getByText("Hi! I'm your AI Shopping Assistant.")).toBeInTheDocument();
    expect(screen.getByText('How can I help you today?')).toBeInTheDocument();
    expect(fake.api.createConversation).not.toHaveBeenCalled();
    expect(fake.api.history).not.toHaveBeenCalled();
  });

  it('W05 AS-53: closing the sheet or moving to another page keeps the reply running; reopening shows the progress', async () => {
    const view = renderLauncher();
    await userEvent.click(launcher());
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'hi{Enter}');
    const call = await fake.call(0);
    act(() => {
      call.emit(META(), '1-0');
      call.emit(TEXT('Hel'), '2-0');
    });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call.aborted()).toBe(false);
    expect(launcher()).toHaveAttribute('data-running', 'true');

    nav.pathname = '/orders';
    view.rerender(
      <QueryClientProvider client={client}>
        <button type="button">Outside</button>
        <AssistantLauncher variant="icon" />
      </QueryClientProvider>,
    );
    act(() => call.emit(TEXT('lo'), '3-0'));
    await userEvent.click(launcher());
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Hello');
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();

    act(() => call.emit(DONE(), '4-0'));
    await act(async () => call.end({ terminal: true }));
    await userEvent.keyboard('{Escape}');
    expect(launcher()).toHaveAttribute('data-running', 'false');
    expect(fake.api.send).toHaveBeenCalledTimes(1);
    expect(fake.api.resume).not.toHaveBeenCalled();
  });

  it('W05 AS-55: a signed-out broadcast closes the sheet, clears storage and the cache, and aborts the read', async () => {
    renderLauncher();
    await userEvent.click(launcher());
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'hi{Enter}');
    const call = await fake.call(0);
    act(() => call.emit(META(), '1-0'));
    saveActive({ conversationId: 'c1', messageId: 'm1', pendingText: 'hi', idempotencyKey: 'k' });
    client.setQueryData(queryKeys.assistant.history('c1'), { conversation: { id: 'c1' }, messages: [] });
    expect(sessionStorage.getItem(SHEET_OPEN_KEY)).toBe('1');

    act(() => authBus.handlers.forEach((handler) => handler('signed-out')));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call.aborted()).toBe(true);
    expect(sessionStorage.getItem(ACTIVE_KEY)).toBeNull();
    expect(sessionStorage.getItem(SHEET_OPEN_KEY)).toBeNull();
    expect(client.getQueryData(queryKeys.assistant.history('c1'))).toBeUndefined();
    expect(launcher()).toHaveAttribute('data-running', 'false');
  });

  it('W05 AS-66: the dialog opens with the tab order Chats, New chat, close, field, location switch, Send', async () => {
    renderLauncher();
    await userEvent.click(launcher());
    const dialog = screen.getByRole('dialog');
    const order = [
      within(dialog).getByRole('button', { name: 'Chats' }),
      within(dialog).getByRole('button', { name: 'New chat' }),
      within(dialog).getByRole('button', { name: 'Close' }),
      within(dialog).getByRole('textbox'),
      within(dialog).getByRole('switch', { name: 'Use my location' }),
      within(dialog).getByRole('button', { name: 'Send message' }),
    ];
    const positions = order.map((element) => Array.from(dialog.querySelectorAll('*')).indexOf(element));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
