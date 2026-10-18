'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AssistantChat } from '@/hooks/use-assistant-chat';
import { assistantApi, assistantProblem } from '@/lib/api/assistant';
import { endSession } from '@/lib/auth/session-ended';
import { formatDiscussionTime } from '@/lib/discussions-time';
import { queryKeys } from '@/lib/query-keys';
import { DeleteConversationDialog } from './delete-conversation-dialog';

const PAGE_SIZE = 20;

/**
 * The member's own conversations, newest first, 20 per page (W05 AS-61, AS-63). It takes the place of the transcript inside the
 * sheet. Choosing a row loads that conversation; a running reply keeps streaming in the background and its row says so.
 */
export function ConversationList({ chat, onChosen }: { chat: AssistantChat; onChosen: () => void }) {
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const query = useInfiniteQuery({
    queryKey: queryKeys.assistant.conversations(),
    queryFn: async ({ pageParam }) => {
      try {
        return await assistantApi.listConversations({ limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) });
      } catch (error) {
        if (assistantProblem(error).status === 401) endSession();
        throw error;
      }
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });

  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading conversations" className="flex flex-1 flex-col gap-2 p-4">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-1 flex-col items-center gap-3 p-6 text-center text-sm">
        <p>We couldn&apos;t load your conversations.</p>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const conversations = query.data.pages.flatMap((page) => page.items);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {conversations.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">No conversations yet.</p>
      ) : (
        <ul className="m-0 list-none divide-y p-0">
          {conversations.map((conversation) => {
            const time = formatDiscussionTime(conversation.updatedAt);
            const answering = chat.runningConversationId === conversation.id;
            return (
              <li key={conversation.id} className="flex items-center gap-1 pr-2">
                <button
                  type="button"
                  aria-current={chat.conversationId === conversation.id ? 'true' : undefined}
                  onClick={() => {
                    chat.selectConversation(conversation.id);
                    onChosen();
                  }}
                  className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left hover:bg-accent focus-visible:bg-accent"
                >
                  <span className="w-full break-words text-sm font-medium">{conversation.title}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <time dateTime={time.dateTime} title={time.title}>
                      {time.text}
                    </time>
                    {answering && <span className="font-medium text-green-700 dark:text-green-400">Answering…</span>}
                  </span>
                </button>
                <Button type="button" variant="ghost" size="icon" aria-label={`Delete ${conversation.title}`} className="min-h-11 min-w-11" onClick={() => setDeleting({ id: conversation.id, title: conversation.title })}>
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {query.hasNextPage && (
        <div className="flex justify-center p-3">
          <Button type="button" variant="outline" className="min-h-11" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            Show more
          </Button>
        </div>
      )}
      <DeleteConversationDialog
        conversation={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          chat.conversationDeleted(id);
          void query.refetch();
        }}
      />
    </div>
  );
}
