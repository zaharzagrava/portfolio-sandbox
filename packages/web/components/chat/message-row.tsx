'use client';

import type { ChatMessage } from '@marketplace-sandbox/contracts';
import { useEffect, useRef } from 'react';
import { DaySeparator } from '@/components/chat/day-separator';
import { MessageActions } from '@/components/chat/message-actions';
import { SeenBy } from '@/components/chat/seen-by';
import { Button } from '@/components/ui/button';
import { useDeadlinePassed } from '@/hooks/use-deadline';
import { preview, type MyRole } from '@/lib/chat/message-rules';
import type { PendingMessage } from '@/lib/chat/pending-messages';
import type { MessageRow as MessageRowData, PendingRow, Row } from '@/lib/chat/rows';
import { authorLabel, messageTime } from '@/lib/chat/time-format';

/** What a row needs from the conversation; passed through the list's `context` so the row components stay stable. */
export type RowContext = {
  channelId: string;
  title: string;
  selfId: string | null;
  sellerId: string;
  myRole: MyRole;
  byId: ReadonlyMap<string, ChatMessage>;
  onReply: (message: ChatMessage) => void;
  onRetry: (clientMessageId: string) => void;
  onDiscard: (clientMessageId: string) => void;
  /** "Seen" / "Seen by n" belongs under this one message of the member's own (AS-33). */
  seen: { messageId: string; label: string } | null;
  /** Each message of another member reports when it is in view, for read marking (AS-31); returns how to stop. */
  observe?: (element: Element, seq: number) => () => void;
};

const BUBBLE = 'max-w-[85%] rounded-2xl px-3 py-2 text-sm';

/** The words under a "Not sent" bubble, from the stable problem code (AS-18). */
function reasonText(reason: string | undefined): string | null {
  if (reason === 'reply_target_invalid') return 'The message you replied to is no longer available.';
  if (reason === 'validation_failed') return "That message can't be sent.";
  return null;
}

function Quote({ message, context }: { message: ChatMessage; context: RowContext }) {
  if (!message.replyToId) return null;
  const original = context.byId.get(message.replyToId);
  const text = !original ? 'Original message' : original.deleted ? 'Message removed' : `${authorLabel(original.authorId, context)}: ${preview(original.body ?? '')}`;
  return <p className="mb-1 truncate border-l-2 border-current/40 pl-2 text-xs opacity-80">{text}</p>;
}

function RetryButton({ item, onRetry }: { item: PendingMessage; onRetry: (id: string) => void }) {
  const waited = useDeadlinePassed(item.retryAfterAt ?? null);
  return (
    <Button type="button" variant="outline" size="sm" className="min-h-11 text-foreground sm:min-h-7" disabled={!waited} onClick={() => onRetry(item.clientMessageId)}>
      Retry
    </Button>
  );
}

function PendingBubble({ row, context }: { row: PendingRow; context: RowContext }) {
  const { item } = row;
  const failed = item.state === 'failed';
  const reason = failed ? reasonText(item.reason) : null;
  return (
    <div data-testid="chat-message" data-own="true" data-pending={item.state} className="flex justify-end px-3 py-1">
      <div className={`${BUBBLE} bg-primary text-primary-foreground`}>
        <p className="text-xs font-medium opacity-90">You</p>
        <p data-body className="whitespace-pre-wrap break-words">
          {item.body}
        </p>
        <p className="mt-1 text-xs opacity-90">{failed ? 'Not sent' : 'Sending…'}</p>
        {reason && <p className="text-xs">{reason}</p>}
        {failed && (
          <div className="mt-1 flex gap-2">
            <RetryButton item={item} onRetry={context.onRetry} />
            <Button type="button" variant="outline" size="sm" className="min-h-11 text-foreground sm:min-h-7" onClick={() => context.onDiscard(item.clientMessageId)}>
              Discard
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ row, context }: { row: MessageRowData; context: RowContext }) {
  const { message } = row;
  const own = message.authorId === context.selfId;
  const label = authorLabel(message.authorId, context);
  const time = messageTime(message.createdAt);
  const seen = context.seen?.messageId === message.id ? context.seen.label : null;
  // Other members' messages tell the read tracker when they are in view; the member's own never do (AS-31).
  const element = useRef<HTMLDivElement>(null);
  const { observe } = context;
  useEffect(() => {
    if (!element.current || own || !observe) return;
    return observe(element.current, message.seq);
  }, [observe, own, message.seq]);
  return (
    <div
      data-testid="chat-message"
      data-own={own ? 'true' : 'false'}
      data-message-id={message.id}
      data-seq={message.seq}
      ref={element}
      className={`flex items-start gap-1 px-3 py-1 ${own ? 'flex-row-reverse' : ''}`}
    >
      <div className={`${BUBBLE} ${own ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
        <p className="flex items-baseline gap-2 text-xs font-medium opacity-90">
          <span>{label}</span>
          <time dateTime={message.createdAt} className="font-normal">
            {time}
          </time>
        </p>
        <Quote message={message} context={context} />
        {message.deleted ? (
          <p data-body className="italic opacity-80">
            Message removed
          </p>
        ) : (
          <p data-body className="whitespace-pre-wrap break-words">
            {message.body}
          </p>
        )}
        {seen && <SeenBy label={seen} />}
      </div>
      <MessageActions channelId={context.channelId} message={message} authorLabel={label} time={time} selfId={context.selfId} myRole={context.myRole} onReply={context.onReply} />
    </div>
  );
}

/** One row of the list: the separators that sit before it (new messages, a new day), then the message or the pending bubble. */
export function MessageRow({ row, context }: { row: Row; context: RowContext }) {
  if (row.kind === 'pending') return <PendingBubble row={row} context={context} />;
  return (
    <>
      {row.divider !== null && (
        <div role="separator" aria-label={`${row.divider} new message${row.divider === 1 ? '' : 's'}`} className="my-2 flex items-center gap-3 px-3 text-xs font-semibold text-primary">
          <span className="h-px flex-1 bg-primary/40" />
          <span>
            {row.divider} new message{row.divider === 1 ? '' : 's'}
          </span>
          <span className="h-px flex-1 bg-primary/40" />
        </div>
      )}
      {row.day && <DaySeparator label={row.day} />}
      <MessageBubble row={row} context={context} />
    </>
  );
}
