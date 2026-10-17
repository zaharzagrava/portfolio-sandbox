'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ProblemPanel } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { useReplayEvent, useWebhookEvent } from '@/lib/api/seller-developers';
import { DialogProblem, Instant } from './shared';

/**
 * One event of a delivery log (W04 AS-66, AS-67): its facts and its stored body as formatted text in a `pre` (never as
 * HTML), and "Replay". The `Idempotency-Key` of a replay is created when the panel opens and reused for retries of the same
 * intent; a new intent (the next replay after a queued one) and a different event get another key. Mount it with
 * `key={eventId}`.
 */
export function EventPanel({ shopId, endpointId, eventId, canReplay, onClose }: { shopId: string; endpointId: string; eventId: string; canReplay: boolean; onClose: () => void }) {
  const event = useWebhookEvent(shopId, endpointId, eventId);
  const replay = useReplayEvent(shopId, endpointId);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function confirmReplay() {
    setProblem(null);
    try {
      await replay.mutateAsync({ eventId, idempotencyKey });
      toast.success('Replay queued');
      setIdempotencyKey(newIdempotencyKey());
      setConfirming(false);
    } catch (error) {
      setProblem(problemFromError(error));
      throw error;
    }
  }

  const data = event.data;
  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Event details</DialogTitle>
            <DialogDescription>What we stored for this event, as it was sent.</DialogDescription>
          </DialogHeader>
          {event.isError ? (
            <ProblemPanel problem={problemFromError(event.error)} context={{ kind: 'read' }} onRetry={event.error && problemFromError(event.error).status >= 500 ? () => void event.refetch() : undefined} />
          ) : !data ? (
            <div aria-hidden="true" className="space-y-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <div className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Event ID</dt>
                <dd className="font-mono break-all">{data.eventId}</dd>
                <dt className="text-muted-foreground">Type</dt>
                <dd>{data.type}</dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>
                  <Instant value={data.createdAt} />
                </dd>
                <dt className="text-muted-foreground">State</dt>
                <dd>{data.state}</dd>
                <dt className="text-muted-foreground">Attempts</dt>
                <dd>{data.attempts}</dd>
              </dl>
              <pre tabIndex={0} aria-label="Event body" className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(data.body, null, 2)}
              </pre>
              {canReplay && (
                <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => (setProblem(null), setConfirming(true))}>
                  Replay
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Replay this event?"
        description="The same body is sent again, signed now."
        confirmLabel="Replay event"
        error={problem ? <DialogProblem problem={problem} /> : undefined}
        onConfirm={confirmReplay}
      />
    </>
  );
}
