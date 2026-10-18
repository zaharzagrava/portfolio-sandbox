import { Bot, User } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { TranscriptMessage } from '@/hooks/use-assistant-chat';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';
import { ToolChips } from './tool-chips';

export type { TranscriptMessage };

/** One bubble. User text is plain text; the assistant's answer is safe Markdown. Hidden prefixes tell a screen reader who spoke. */
export function ChatMessage({ message }: { message: TranscriptMessage }) {
  const isAssistant = message.role === 'assistant';
  return (
    <div className={cn('flex w-full gap-3', isAssistant ? 'justify-start' : 'justify-end')}>
      {isAssistant && (
        <Avatar className="mt-1 h-8 w-8 shrink-0">
          <AvatarFallback className="bg-primary/10 text-primary">
            <Bot aria-hidden="true" className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
      <div className={cn('flex min-w-0 max-w-[85%] flex-col gap-2', isAssistant ? 'items-start' : 'items-end')}>
        {isAssistant && <ToolChips tools={message.tools} />}
        {(message.content || message.live === 'thinking') && (
          <div className={cn('rounded-lg px-4 py-2.5 text-sm', isAssistant ? 'bg-muted text-foreground' : 'bg-primary text-primary-foreground')}>
            <span className="sr-only">{isAssistant ? 'Assistant said:' : 'You said:'}</span>
            {message.content ? (
              isAssistant ? (
                <div className="prose prose-sm dark:prose-invert max-w-none break-words" data-testid="assistant-message">
                  <Markdown>{message.content}</Markdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words" data-testid="user-message">
                  {message.content}
                </p>
              )
            ) : (
              <span>Thinking…</span>
            )}
          </div>
        )}
        {message.live === 'reconnecting' && (
          <p role="status" className="text-xs text-muted-foreground">
            Reconnecting…
          </p>
        )}
        {message.live === 'stopping' && (
          <p role="status" className="text-xs text-muted-foreground">
            Stopping…
          </p>
        )}
      </div>
      {!isAssistant && (
        <Avatar className="mt-1 h-8 w-8 shrink-0">
          <AvatarFallback className="bg-primary text-primary-foreground">
            <User aria-hidden="true" className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}
