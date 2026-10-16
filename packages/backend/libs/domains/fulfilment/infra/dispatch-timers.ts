import { Injectable } from '@nestjs/common';
import {
  offerTimeoutMessageSchema,
  type OfferTimeoutMessage,
} from '@marketplace-sandbox/contracts';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import type { DispatchTimers } from '../domain/delivery-ports';

/** Standard queue (no group id, L-001); `delivery-offer-timeouts-dlq` is configured on the queue itself. */
export const OFFER_TIMEOUT_QUEUE = 'delivery-offer-timeouts';
/** SQS delays go to 900 s; ours are 15 s and 20 s. */
const MAX_DELAY_SECONDS = 900;
const ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * The delayed timer messages (S20 R-2, A9): validated where the message is created, with an explicit timeout. They are an
 * accelerator: the due time lives on the delivery and the recovery job covers a message that never arrived, so a failure
 * here is the caller's to log, not to retry.
 */
@Injectable()
export class SqsDispatchTimers implements DispatchTimers {
  constructor(private readonly queue: TaskQueue) {}

  async enqueue(
    message: OfferTimeoutMessage,
    delaySeconds: number,
  ): Promise<void> {
    const body = offerTimeoutMessageSchema.parse(message);
    const delay = Math.min(
      MAX_DELAY_SECONDS,
      Math.max(0, Math.ceil(delaySeconds)),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.enqueue(OFFER_TIMEOUT_QUEUE, body, { delaySeconds: delay }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timer enqueue timed out')),
            ENQUEUE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
