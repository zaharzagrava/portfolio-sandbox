import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesOf, type MessagesData } from '@/lib/chat/message-cache';
import { queryKeys } from '@/lib/query-keys';
import { CH1, ME, ORIGIN, SELLER, chatClient, historyPage, message, problemBody, renderChat } from '@/tests/support/chat-fixtures';
import { server } from '../../vitest.setup';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { MessageActions } from './message-actions';

const own = message(2, { authorId: ME, body: 'mine' });
const theirs = message(3, { authorId: SELLER, body: 'theirs' });
const url = (id: string) => `${ORIGIN}/api/chat/channels/${CH1}/messages/${id}`;

function setup(target = own, role: 'OWNER' | 'MODERATOR' | 'MEMBER' | null = 'MEMBER') {
  const client = chatClient();
  client.setQueryData<MessagesData>(queryKeys.chat.messages(CH1), { pages: [historyPage([theirs, own, message(1)])], pageParams: [undefined] });
  const onReply = vi.fn();
  renderChat(<MessageActions channelId={CH1} message={target} authorLabel="Seller" time="9:05 AM" selfId={ME} myRole={role} onReply={onReply} />, { client });
  return { client, onReply };
}

const trigger = () => screen.getByRole('button', { name: 'Message actions for the message from Seller at 9:05 AM' });
const stored = (client: ReturnType<typeof chatClient>, id: string) => messagesOf(client.getQueryData<MessagesData>(queryKeys.chat.messages(CH1))).find((m) => m.id === id);

beforeEach(() => {
  toast.error.mockReset();
  toast.success.mockReset();
});

describe('Message actions', () => {
  it('W05 AS-20 AS-39: the menu button is named with the author and time, and offers Reply', async () => {
    const { onReply } = setup(theirs);
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reply' }));
    await waitFor(() => expect(onReply).toHaveBeenCalledWith(theirs));
  });

  it('W05 AS-20: a member sees Delete on their own message only', async () => {
    setup(own, 'MEMBER');
    await userEvent.click(trigger());
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('W05 AS-20: a member does not see Delete on someone else\'s message', async () => {
    setup(theirs, 'MEMBER');
    await userEvent.click(trigger());
    await screen.findByRole('menuitem', { name: 'Reply' });
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it.each(['OWNER', 'MODERATOR'] as const)('W05 AS-20: a chat %s sees Delete on any message', async (role) => {
    setup(theirs, role);
    await userEvent.click(trigger());
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('W05 AS-20: a deleted message has no actions', () => {
    setup({ ...own, deleted: true, body: null });
    expect(screen.queryByRole('button', { name: /Message actions/ })).not.toBeInTheDocument();
  });

  it('W05 AS-20: choosing Delete asks "Delete this message? This can\'t be undone." with focus on Cancel; Esc cancels and focus returns to the menu button', async () => {
    const { client } = setup(own);
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this message?' });
    expect(dialog).toHaveTextContent("This can't be undone.");
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger()).toHaveFocus());
    expect(stored(client, own.id)?.deleted).toBe(false);
  });

  it('W05 AS-20: confirming deletes on 204 and the message becomes the tombstone in place, same sequence', async () => {
    let called = 0;
    server.use(
      http.delete(url(own.id), () => {
        called += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { client } = setup(own);
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(stored(client, own.id)).toMatchObject({ deleted: true, body: null, seq: 2 }));
    expect(called).toBe(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('W05 AS-20: 403 permission_denied shows the toast "You can\'t delete this message." and keeps the message', async () => {
    server.use(http.delete(url(own.id), () => problemBody(403, 'permission_denied')));
    const { client } = setup(own);
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You can't delete this message."));
    expect(stored(client, own.id)?.deleted).toBe(false);
  });

  it('W05 AS-20: 404 (already deleted) is treated as success', async () => {
    server.use(http.delete(url(own.id), () => problemBody(404, 'message_not_found')));
    const { client } = setup(own);
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(stored(client, own.id)?.deleted).toBe(true));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
