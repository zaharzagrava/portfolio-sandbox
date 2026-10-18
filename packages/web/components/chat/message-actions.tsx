'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '@marketplace-sandbox/contracts';
import { Ellipsis } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { DeleteMessageDialog } from '@/components/chat/delete-message-dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { chatApi, chatProblem } from '@/lib/api/chat';
import { deleteCopy } from '@/lib/chat/errors-copy';
import { markDeleted, type MessagesData } from '@/lib/chat/message-cache';
import { canDeleteMessage, type MyRole } from '@/lib/chat/message-rules';
import { queryKeys } from '@/lib/query-keys';

/**
 * The menu of one message (W05 AS-20, AS-21, AS-39): **Reply** for any message that is not deleted, **Delete** for its author
 * and for the chat's owner and moderators. Deleting asks first; `204` and `404` (already gone) both turn the message into
 * the tombstone in place, `403` is a toast. The server decides again on every call.
 */
export function MessageActions({
  channelId,
  message,
  authorLabel,
  time,
  selfId,
  myRole,
  onReply,
}: {
  channelId: string;
  message: ChatMessage;
  authorLabel: string;
  time: string;
  selfId: string | null;
  myRole: MyRole;
  onReply: (message: ChatMessage) => void;
}) {
  const queryClient = useQueryClient();
  const trigger = useRef<HTMLButtonElement>(null);
  /** Set when **Reply** is chosen; the reply is applied when the menu has closed (see `onCloseAutoFocus`). */
  const replied = useRef(false);
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation({
    mutationFn: () => chatApi.remove(channelId, message.id),
    onSuccess: () => finish(),
    onError: (error) => {
      const copy = deleteCopy(chatProblem(error));
      if (copy.effect === 'done') return finish();
      toast.error(copy.text);
      setConfirming(false);
    },
  });

  function finish() {
    queryClient.setQueryData<MessagesData>(queryKeys.chat.messages(channelId), (held) => markDeleted(held, message.id));
    setConfirming(false);
  }

  if (message.deleted) return null;
  const allowDelete = canDeleteMessage(message, selfId, myRole);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Message actions for the message from ${authorLabel} at ${time}`}>
            <Ellipsis aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-auto"
          onCloseAutoFocus={(event) => {
            // Choosing Reply moves focus to the message field, once the menu has let go of it; the menu must not take it back to its button.
            if (!replied.current) return;
            event.preventDefault();
            replied.current = false;
            onReply(message);
          }}
        >
          <DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={() => (replied.current = true)}>
            Reply
          </DropdownMenuItem>
          {allowDelete && (
            <DropdownMenuItem variant="destructive" className="min-h-11 sm:min-h-8" onSelect={() => setConfirming(true)}>
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteMessageDialog open={confirming} busy={remove.isPending} onOpenChange={setConfirming} onConfirm={() => remove.mutate()} returnFocusTo={trigger} />
    </>
  );
}
