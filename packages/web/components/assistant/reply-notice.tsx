'use client';

import { Button } from '@/components/ui/button';
import type { Notice } from '@/hooks/use-assistant-chat';

/**
 * The one inline message under the transcript (W05 AS-56..AS-59, FR-060): a refused send, a reply that ended in an error, a
 * refusal. Always `role="alert"`, never a toast. The text arrives already chosen from `lib/assistant/problem-copy.ts`; this only
 * shows it and offers the next step (**Try again** puts the question back in the field, **New chat** for a full conversation).
 */
export function ReplyNotice({ notice, onTryAgain, onNewChat }: { notice: Notice; onTryAgain: () => void; onNewChat: () => void }) {
  return (
    <div role="alert" className="mx-4 mb-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
      <p>{notice.text}</p>
      {notice.reference && <p className="mt-1 text-xs">{notice.reference}</p>}
      {(notice.tryAgain || notice.newChat) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {notice.tryAgain && (
            <Button type="button" size="sm" variant="outline" className="min-h-11 min-w-11" onClick={onTryAgain}>
              Try again
            </Button>
          )}
          {notice.newChat && (
            <Button type="button" size="sm" variant="outline" className="min-h-11 min-w-11" onClick={onNewChat}>
              New chat
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
