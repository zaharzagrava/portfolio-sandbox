'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { assistantApi, assistantProblem } from '@/lib/api/assistant';
import { endSession } from '@/lib/auth/session-ended';

type Failure = 'busy' | 'failed' | null;

const FAILURE_COPY: Record<Exclude<Failure, null>, string> = {
  busy: 'Wait for the reply to finish, then delete the conversation.',
  failed: "We couldn't delete this conversation. Try again.",
};

/**
 * "Delete this conversation?" (W05 AS-63): a confirmation with the focus on **Cancel**. `204` and `404` both mean it is gone;
 * `409 turn_in_progress` asks the member to wait for the running reply.
 */
export function DeleteConversationDialog({ conversation, onClose, onDeleted }: { conversation: { id: string; title: string } | null; onClose: () => void; onDeleted: (id: string) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [failure, setFailure] = useState<Failure>(null);
  const [working, setWorking] = useState(false);

  const close = () => {
    setFailure(null);
    onClose();
  };

  const confirm = async () => {
    if (!conversation || working) return;
    setWorking(true);
    setFailure(null);
    try {
      await assistantApi.deleteConversation(conversation.id);
    } catch (error) {
      const { status } = assistantProblem(error);
      if (status === 401) endSession();
      if (status !== 404) {
        setFailure(status === 409 ? 'busy' : 'failed');
        setWorking(false);
        return;
      }
    }
    setWorking(false);
    onDeleted(conversation.id);
    close();
  };

  return (
    <Dialog open={conversation !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete this conversation?</DialogTitle>
          <DialogDescription>Its messages are removed permanently.</DialogDescription>
        </DialogHeader>
        {conversation && <p className="break-words text-sm font-medium">{conversation.title}</p>}
        {failure && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {FAILURE_COPY[failure]}
          </p>
        )}
        <DialogFooter>
          <Button ref={cancel} type="button" variant="outline" className="min-h-11 min-w-11" onClick={close}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" className="min-h-11 min-w-11" disabled={working} onClick={() => void confirm()}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
