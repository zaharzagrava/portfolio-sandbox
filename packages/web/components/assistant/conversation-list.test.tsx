import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_ID, DONE, META, TEXT } from '../../tests/support/fake-assistant';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';

const fake = await vi.hoisted(async () => (await import('../../tests/support/fake-assistant')).createFakeAssistant());

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', role: 'USER' }, status: 'authenticated', isAuthenticated: true, isLoading: false }) }));
vi.mock('@/lib/api/assistant', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api/assistant')>()), assistantApi: fake.api }));

import { useAssistantChat } from '@/hooks/use-assistant-chat';
import { AssistantRejected } from '@/lib/api/assistant';
import { AssistantSheet } from './assistant-sheet';

const SECOND = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const row = (id: string, title: string, updatedAt = '2026-10-17T09:00:00.000Z') => ({ id, title, updatedAt, messageCount: 2 });

function Harness() {
  const chat = useAssistantChat({ active: true });
  return <AssistantSheet open onOpenChange={() => undefined} chat={chat} />;
}

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const historyOf = (id: string, text: string) => ({
  conversation: { id, title: 'T', updatedAt: '2026-10-17T09:00:00.000Z' },
  messages: [
    { id: `${id}-u`, turnId: 't1', role: 'user' as const, text: `question ${text}`, tools: [] },
    { id: `${id}-a`, turnId: 't1', role: 'assistant' as const, text: `answer ${text}`, tools: ['search_products'] },
  ],
});

const chats = () => screen.getByRole('button', { name: 'Chats' });
const newChat = () => screen.getByRole('button', { name: 'New chat' });
async function openList() {
  await userEvent.click(chats());
}

beforeEach(() => {
  fake.reset();
  sessionStorage.clear();
  vi.useRealTimers();
  rearmSessionEnd();
  fake.api.listConversations.mockResolvedValue({ items: [row(CONVERSATION_ID, 'Coffee grinder'), row(SECOND, 'Pickup near me', '2026-10-10T09:00:00.000Z')], nextCursor: null });
  fake.api.history.mockImplementation(async (id: string) => historyOf(id, id === CONVERSATION_ID ? 'one' : 'two'));
});
afterEach(() => setSessionEndHandler(null));

describe('Assistant conversations', () => {
  it('W05 AS-61: the Chats button opens the list in place of the transcript, newest first, with titles and times', async () => {
    renderSheet();
    await openList();
    const items = await screen.findAllByRole('listitem');
    expect(items.map((item) => within(item).getByText(/Coffee grinder|Pickup near me/).textContent)).toEqual(['Coffee grinder', 'Pickup near me']);
    expect(within(items[0]).getByText(/ago|just now|\d{4}/)).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
    expect(fake.api.listConversations).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    // pressing Chats again goes back to the transcript
    await openList();
    expect(screen.getByRole('log')).toBeInTheDocument();
  });

  it('W05 AS-61: Show more appends the next page and disappears at the end', async () => {
    fake.api.listConversations
      .mockResolvedValueOnce({ items: [row(CONVERSATION_ID, 'First')], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [row(SECOND, 'Second')], nextCursor: null });
    renderSheet();
    await openList();
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(fake.api.listConversations).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-2' }));
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('W05 AS-61: choosing a conversation loads its history and closes the list', async () => {
    renderSheet();
    await openList();
    await userEvent.click(await screen.findByRole('button', { name: /^Pickup near me/ }));
    expect(await screen.findByText('answer two')).toBeInTheDocument();
    expect(screen.getByText('question two')).toBeInTheDocument();
    expect(screen.getByText('Searched products')).toBeInTheDocument();
    expect(fake.api.history).toHaveBeenCalledWith(SECOND);
    expect(screen.queryByText('No conversations yet.')).toBeNull();
    expect(screen.getByRole('log')).toBeInTheDocument();
  });

  it('W05 AS-61: loading and empty states', async () => {
    let resolve!: (value: { items: never[]; nextCursor: null }) => void;
    fake.api.listConversations.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderSheet();
    await openList();
    expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeInTheDocument();
    await act(async () => resolve({ items: [], nextCursor: null }));
    expect(await screen.findByText('No conversations yet.')).toBeInTheDocument();
  });

  it('W05 AS-61: a failed list says so with Try again', async () => {
    fake.api.listConversations.mockRejectedValueOnce(new Error('down'));
    renderSheet();
    await openList();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load your conversations.");
    fake.api.listConversations.mockResolvedValueOnce({ items: [row(CONVERSATION_ID, 'Back again')], nextCursor: null });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Back again')).toBeInTheDocument();
  });

  it('W05 AS-61: a running reply keeps streaming while another conversation is open, and its row says so', async () => {
    renderSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'hi{Enter}');
    const call = await fake.call(0);
    act(() => {
      call.emit(META('m1', CONVERSATION_ID), '1-0');
      call.emit(TEXT('Hel'), '2-0');
    });

    await openList();
    const running = await screen.findByRole('button', { name: /^Coffee grinder/ });
    expect(within(running.closest('li') as HTMLElement).getByText('Answering…')).toBeInTheDocument();
    expect(within(screen.getAllByRole('listitem')[1]).queryByText('Answering…')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /^Pickup near me/ }));
    expect(await screen.findByText('answer two')).toBeInTheDocument();
    act(() => call.emit(TEXT('lo'), '3-0'));
    expect(call.aborted()).toBe(false);

    // back to the running conversation: the progress is there, and the end lands in it
    await openList();
    await userEvent.click(await screen.findByRole('button', { name: /^Coffee grinder/ }));
    expect(screen.getAllByTestId('assistant-message').at(-1)).toHaveTextContent('Hello');
    act(() => call.emit(DONE(), '4-0'));
    await act(async () => call.end({ terminal: true }));
    expect(fake.api.send).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-62: New chat clears the transcript with no request, keeps the field text, and is disabled when the chat is empty', async () => {
    renderSheet();
    expect(newChat()).toBeDisabled();
    await openList();
    await userEvent.click(await screen.findByRole('button', { name: /^Coffee grinder/ }));
    expect(await screen.findByText('answer one')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'half a thought');
    expect(newChat()).toBeEnabled();
    const created = fake.api.createConversation.mock.calls.length;
    await userEvent.click(newChat());
    expect(screen.queryByText('answer one')).toBeNull();
    expect(screen.getByText("Hi! I'm your AI Shopping Assistant.")).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message to the assistant' })).toHaveValue('half a thought');
    expect(fake.api.createConversation.mock.calls.length).toBe(created);
    expect(newChat()).toBeDisabled();
  });

  it('W05 AS-63: Delete asks first with focus on Cancel; on 204 the row goes', async () => {
    renderSheet();
    await openList();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Pickup near me' }));
    const dialog = screen.getByRole('dialog', { name: /Delete this conversation\?/ });
    expect(dialog).toHaveTextContent('Its messages are removed permanently.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fake.api.deleteConversation).not.toHaveBeenCalled();

    fake.api.listConversations.mockResolvedValue({ items: [row(CONVERSATION_ID, 'Coffee grinder')], nextCursor: null });
    await userEvent.click(screen.getByRole('button', { name: 'Delete Pickup near me' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: /Delete this conversation\?/ })).getByRole('button', { name: 'Delete' }));
    expect(fake.api.deleteConversation).toHaveBeenCalledWith(SECOND);
    await vi.waitFor(() => expect(screen.queryByText('Pickup near me')).toBeNull());
    expect(screen.getByText('Coffee grinder')).toBeInTheDocument();
  });

  it('W05 AS-63: deleting the open conversation shows the empty state', async () => {
    renderSheet();
    await openList();
    await userEvent.click(await screen.findByRole('button', { name: /^Coffee grinder/ }));
    expect(await screen.findByText('answer one')).toBeInTheDocument();
    await openList();
    fake.api.listConversations.mockResolvedValue({ items: [row(SECOND, 'Pickup near me')], nextCursor: null });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Coffee grinder' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: /Delete this conversation\?/ })).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(screen.queryByText('Coffee grinder')).toBeNull());
    await userEvent.click(chats());
    expect(screen.getByText("Hi! I'm your AI Shopping Assistant.")).toBeInTheDocument();
    expect(screen.queryByText('answer one')).toBeNull();
  });

  it('W05 AS-63: 409 turn_in_progress says to wait for the reply; 404 counts as deleted', async () => {
    renderSheet();
    await openList();
    fake.api.deleteConversation.mockRejectedValueOnce({ response: { status: 409, data: { code: 'turn_in_progress' }, headers: {} } });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Coffee grinder' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: /Delete this conversation\?/ })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Wait for the reply to finish, then delete the conversation.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { hidden: true })).getByText('Coffee grinder')).toBeInTheDocument();

    fake.api.deleteConversation.mockRejectedValueOnce({ response: { status: 404, data: { code: 'not_found' }, headers: {} } });
    fake.api.listConversations.mockResolvedValue({ items: [row(SECOND, 'Pickup near me')], nextCursor: null });
    await userEvent.click(within(screen.getByRole('dialog', { name: /Delete this conversation\?/ })).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(screen.queryByText('Coffee grinder')).toBeNull());
  });

  it('W05 AS-64: a full conversation replaces the composer with New chat and keeps the history readable', async () => {
    renderSheet();
    await openList();
    await userEvent.click(await screen.findByRole('button', { name: /^Coffee grinder/ }));
    expect(await screen.findByText('answer one')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'one more{Enter}');
    const call = await fake.call(0);
    await act(async () => call.fail(new AssistantRejected(409, { code: 'conversation_full' }, {})));
    expect(screen.queryByRole('textbox', { name: 'Message to the assistant' })).toBeNull();
    expect(screen.getByText('This chat is full.')).toBeInTheDocument();
    expect(screen.getByText('answer one')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'New chat' }));
    expect(screen.getByRole('textbox', { name: 'Message to the assistant' })).toBeInTheDocument();
    expect(screen.queryByText('answer one')).toBeNull();
  });
});
