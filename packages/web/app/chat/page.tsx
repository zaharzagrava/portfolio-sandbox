import type { Metadata } from 'next';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { ChatShell } from '@/components/chat/chat-shell';
import { ChatSkeleton } from '@/components/chat/chat-skeleton';
import { requireServerSession } from '@/lib/auth/session.server';
import { queryKeys } from '@/lib/query-keys';
import { getInboxPage } from '@/lib/server/chat.server';

export const metadata: Metadata = { title: 'Your chats', robots: { index: false, follow: false } };

type Params = Record<string, string | string[] | undefined>;

/** The full address the visitor asked for, query included, so sign-in brings them back to it (W05 FR-002, AS-06). */
function returnToOf(params: Params): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) query.set(name, first);
  }
  const text = query.toString();
  return text ? `/chat?${text}` : '/chat';
}

/**
 * The guard and the first inbox read, inside `<Suspense>` (W05 AS-69): an anonymous visitor goes to sign-in before any member
 * data is read; a member's first page of chats is read on the server and handed to the browser's query cache. A failed read is
 * left out (the browser reads again and shows its own state). Nothing here is cached: the data is private and per member.
 */
async function GuardedChat({ searchParams }: { searchParams: Promise<Params> }) {
  await requireServerSession(returnToOf(await searchParams));
  const read = await getInboxPage();
  const client = new QueryClient();
  if (read.ok) client.setQueryData(queryKeys.chat.inbox(), { pages: [read.data], pageParams: [undefined] });
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <ChatShell />
    </HydrationBoundary>
  );
}

export default function ChatPage({ searchParams }: { searchParams: Promise<Params> }) {
  return (
    <Suspense fallback={<ChatSkeleton />}>
      <GuardedChat searchParams={searchParams} />
    </Suspense>
  );
}
