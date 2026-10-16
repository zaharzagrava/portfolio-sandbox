import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import type { ExportLiveEvent, ExportLivePort } from '../domain/export-ports';

const LOG_EVERY_MS = 60_000;

/**
 * The live channel `order-export:<exportId>` (S12 FR-018, FR-019). Advisory: nothing here can fail an export. `progress`
 * is live only; `done`, `failed` and `cancelled` are replayed to a late subscriber. A failure is logged at most once a
 * minute and carries no row data.
 */
@Injectable()
export class ExportLiveAdapter implements ExportLivePort {
  private readonly logger = new Logger(ExportLiveAdapter.name);
  private lastLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly publisher: RealtimePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  publish(exportId: string, event: ExportLiveEvent): void {
    const { type, ...data } = event;
    void Promise.resolve()
      .then(() =>
        this.publisher.publish(`order-export:${exportId}`, type, data, {
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
    this.logger.error(
      `order_export_live_publish_failed: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}
