'use client';

import { useRef, useEffect } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAssistantChat } from '@/hooks/use-assistant-chat';
import { ChatMessage } from './chat-message';
import { useAuth } from '@/hooks/use-auth';
import Link from 'next/link';

export function ChatInterface() {
  const { messages, input, setInput, sendMessage, isStreaming, stopGeneration } = useAssistantChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (scrollRef.current) {
      const scrollContainer = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, [messages, isStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isStreaming) {
        sendMessage(input);
      }
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isStreaming) {
      sendMessage(input);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <Link href="/login" className="underline">Log in</Link> to chat with the shopping assistant.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        <div className="flex flex-col gap-4 pb-4">
          {messages.map((message, i) => (
            <ChatMessage key={message.id || i} message={message} />
          ))}
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground my-8">
              <p>Hi! I'm your AI Shopping Assistant.</p>
              <p className="text-sm mt-2">How can I help you today?</p>
            </div>
          )}
        </div>
      </ScrollArea>
      <div className="p-4 border-t bg-background">
        <form onSubmit={onSubmit} className="flex items-end gap-2 relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask me anything..."
            className="min-h-[60px] max-h-[200px] resize-none pr-12 py-3"
            rows={1}
          />
          <div className="absolute right-2 bottom-2 flex items-center justify-center h-[44px]">
            {isStreaming ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={stopGeneration}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                title="Stop generation"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                disabled={!input.trim()}
                className="h-8 w-8 text-primary hover:text-primary hover:bg-primary/10"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
