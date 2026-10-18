'use client';

import { Send, Square } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { Lock } from '@/hooks/use-assistant-chat';
import { counterView, codePointLength, cutToLimit, shouldSendOnKey } from '@/lib/chat/composer-rules';

export const FIELD_NAME = 'Message to the assistant';

/**
 * The assistant's message field (W05 AS-45): multi-line, Enter sends, Shift+Enter adds a line, never during IME composition,
 * a code-point counter beyond 3,500, cut at 4,000. While a reply runs the field stays editable but sending is off and **Send**
 * is replaced by **Stop generating**. A used-up allowance disables the field with its reason; a full chat replaces it.
 */
export function Composer({
  value,
  onChange,
  onSend,
  canSend,
  running,
  stopping,
  canStop,
  onStop,
  lock,
  onNewChat,
  switcher,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  canSend: boolean;
  running: boolean;
  stopping: boolean;
  canStop: boolean;
  onStop: () => void;
  lock: Lock | null;
  onNewChat: () => void;
  switcher: ReactNode;
}) {
  const count = codePointLength(value);
  const [previous, setPrevious] = useState(count);
  if (previous !== count) setPrevious(count);
  const counter = counterView(count, previous);

  if (lock?.kind === 'full') {
    return (
      <div className="flex flex-col items-start gap-2 border-t p-4">
        <p className="text-sm">{lock.text}</p>
        <Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={onNewChat}>
          New chat
        </Button>
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSendOnKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  const disabled = lock?.kind === 'quota';
  return (
    <form
      className="flex flex-col gap-2 border-t p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      {disabled && (
        <p id="assistant-lock" className="text-sm text-muted-foreground">
          {lock.text}
        </p>
      )}
      <Textarea
        data-autofocus
        value={value}
        onChange={(event) => onChange(cutToLimit(event.target.value))}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-label={FIELD_NAME}
        aria-describedby={disabled ? 'assistant-lock' : undefined}
        placeholder="Ask me anything..."
        className="max-h-[200px] min-h-[60px] resize-none py-3"
        rows={1}
      />
      <div className="flex items-center gap-2">
        {switcher}
        <p aria-live={counter.announce ? 'polite' : 'off'} className="ml-auto text-xs text-muted-foreground">
          {counter.text}
        </p>
        {running ? (
          <Button type="button" variant="outline" size="icon" aria-label={stopping ? 'Stopping…' : 'Stop generating'} aria-disabled={!canStop || stopping} onClick={() => canStop && !stopping && onStop()} className="min-h-11 min-w-11">
            <Square aria-hidden="true" className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <Button type="submit" size="icon" aria-label="Send message" disabled={!canSend} className="min-h-11 min-w-11">
            <Send aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
      </div>
    </form>
  );
}
