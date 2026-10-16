import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ImportProgressEvent } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import type { ImportPublisherPort } from '../domain/ports';

const LOG_EVERY_MS = 60_000;

/**
 * The live channel `import:<importId>` (S07 FR-035, S51). Advisory: nothing here can fail an import. `progress` is live
 * only (after the checkpoint commit); `done`, `failed` and `cancelled` are replayed to a late subscriber. A failure is
 * logged at most once a minute and carries no row data.
 */
@Injectable()
export class ImportLiveAdapter implements ImportPublisherPort {
  private readonly logger = new Logger(ImportLiveAdapter.name);
  private lastLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly publisher: RealtimePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  publish(importId: string, event: ImportProgressEvent): void {
    const { type, ...data } = event;
    void Promise.resolve()
      .then(() =>
        this.publisher.publish(`import:${importId}`, type, data, {
          replay: type !== 'progress',
        }),
      )
      .then((result) => {
        if (result && result.published === false)
          this.failed(new Error('not published'));
      })
      .catch((error: unknown) => this.failed(error));
  }

  private failed(error: unknown): void {
    const now = this.clock.now().getTime();
    if (now - this.lastLoggedAt < LOG_EVERY_MS && now >= this.lastLoggedAt)
      return;
    this.lastLoggedAt = now;
    this.logger.error({
      action: 'import.live_publish_failed',
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}
