import { Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@app/infrastructure/inbox';
import { ReceiptClaim, RoutingReceipts } from '../domain/webhook-ports';

/**
 * Routing receipts over the inbox (S53, `infrastructure:inbox`): one row per `(consumer group, source event id)`. The
 * claim is one atomic statement, so two handlers of the same event never both start; a failed handling leaves the row
 * `FAILED`, which the next claim takes over at once; a handler that died keeps `RECEIVED` and is taken over after the
 * inbox's claim lease. The row is `PROCESSED` only after the whole fan-out was accepted.
 */
@Injectable()
export class InboxRoutingReceipts extends RoutingReceipts {
  private readonly logger = new Logger(InboxRoutingReceipts.name);

  constructor(private readonly inbox: InboxService) {
    super();
  }

  async claim(group: string, sourceEventId: string): Promise<ReceiptClaim> {
    const result = await this.inbox.claim(group, sourceEventId);
    switch (result.outcome) {
      case 'CLAIMED':
        return { outcome: 'claimed', attempts: result.attempts };
      case 'DUPLICATE_DONE':
        return { outcome: 'done' };
      case 'DUPLICATE_IN_PROGRESS':
        return { outcome: 'in_progress' };
    }
  }

  async complete(group: string, sourceEventId: string): Promise<void> {
    await this.inbox.markStatus(group, sourceEventId, 'PROCESSED');
  }

  async fail(group: string, sourceEventId: string): Promise<void> {
    try {
      await this.inbox.markStatus(group, sourceEventId, 'FAILED', 'routing');
    } catch (error) {
      // The failure path must survive the failure (L-016): the claim lease frees the event if this write is lost too.
      this.logger.warn(
        `could not mark a routing receipt failed: ${(error as Error).message}`,
      );
    }
  }
}
