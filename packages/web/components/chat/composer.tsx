'use client';

import { SendHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ComposerStateLine } from '@/components/chat/composer-state';
import { ReplyChip } from '@/components/chat/reply-chip';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { canSend, codePointLength, counterView, cutToLimit, shouldSendOnKey, trimmedBody, type ComposerState } from '@/lib/chat/composer-rules';

/**
 * The message field of a conversation (W05 AS-15, AS-18, AS-21, FR-025, FR-028). Enter sends, Shift+Enter is a newline and
 * Enter during IME composition never sends; the text is trimmed; the limit is 4,000 code points, cut on typing or pasting; the
 * counter shows beyond 3,500. The draft is kept per chat in `drafts`, a `Map` owned by the chat shell: memory only, never
 * stored in the browser. When the chat is off (banned, muted, archived) the reason is text beside the field.
 */
export function Composer({
  channelId,
  drafts,
  state,
  waitLine,
  replyTo,
  onCancelReply,
  onSubmit,
  inputRef,
  autoFocus = false,
}: {
  channelId: string;
  drafts: Map<string, string>;
  state: ComposerState;
  /** "You're sending messages too fast. Try again in {wait}." while a rate-limit wait runs. */
  waitLine: string | null;
  replyTo: { author: string; preview: string } | null;
  onCancelReply: () => void;
  onSubmit: (body: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(() => drafts.get(channelId) ?? '');
  const [previous, setPrevious] = useState(() => codePointLength(drafts.get(channelId) ?? ''));

  const enabled = state.enabled;
  // Focus the field once, as soon as it can take it (it is off until the chat has loaded).
  const focused = useRef(false);
  useEffect(() => {
    if (!autoFocus || !enabled || focused.current) return;
    focused.current = true;
    inputRef.current?.focus();
  }, [autoFocus, enabled, inputRef]);

  const count = codePointLength(text);
  const counter = counterView(count, previous);

  function change(value: string) {
    const next = cutToLimit(value);
    setPrevious(count);
    setText(next);
    drafts.set(channelId, next);
  }

  function send() {
    if (!canSend(text, { enabled, sending: false })) return;
    onSubmit(trimmedBody(text));
    setPrevious(0);
    setText('');
    drafts.delete(channelId);
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSendOnKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) return;
    event.preventDefault();
    send();
  }

  if (!state.enabled && state.reason === 'banned') {
    return (
      <div className="border-t p-3">
        <ComposerStateLine state={state} />
      </div>
    );
  }

  return (
    <form
      aria-label="Write a message"
      className="flex flex-col gap-2 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {replyTo && <ReplyChip author={replyTo.author} preview={replyTo.preview} onCancel={onCancelReply} />}
      <ComposerStateLine state={state} />
      {waitLine && (
        <p role="status" className="text-sm text-muted-foreground">
          {waitLine}
        </p>
      )}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-field`} className="sr-only">
            Message
          </label>
          <Textarea
            id={`${id}-field`}
            ref={inputRef}
            value={text}
            rows={1}
            placeholder="Type a message…"
            disabled={!enabled}
            onChange={(event) => change(event.target.value)}
            onKeyDown={onKeyDown}
            className="max-h-40 min-h-11 resize-none"
          />
        </div>
        <Button type="submit" className="min-h-11 min-w-11 sm:min-h-9" aria-label="Send message" disabled={!canSend(text, { enabled, sending: false })}>
          <SendHorizontal aria-hidden="true" />
        </Button>
      </div>
      {counter.visible && (
        <p aria-live={counter.announce ? 'polite' : 'off'} className={`text-right text-xs ${count >= 4000 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
          {counter.text}
        </p>
      )}
    </form>
  );
}
