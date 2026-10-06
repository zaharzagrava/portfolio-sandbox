import { Suspense } from 'react';
import { ChatView } from './chat-view';

/** Reads `?product=` on the client, so it streams in behind Suspense (Cache Components). */
export default function ChatPage() {
  return (
    <Suspense fallback={<div className="container mx-auto py-10 px-4 text-muted-foreground">Loading chat…</div>}>
      <ChatView />
    </Suspense>
  );
}
