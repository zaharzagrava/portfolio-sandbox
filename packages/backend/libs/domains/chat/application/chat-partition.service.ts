import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { chatDefaultPartitionRowsGauge } from '../domain/chat-metrics';
import { CHAT_SETTINGS } from '../domain/chat-settings.token';
import type { ChatSettings } from '../domain/config';
import { partitionMonths } from '../domain/partition-months';
import { PORTS, type PartitionRepository } from '../domain/ports';

export interface PartitionRun {
  created: string[];
  moved: number;
  defaultRows: number;
}

/**
 * Monthly partitions of `ChatMessage`, always created ahead (S24 FR-024, P0318, AS-29): the current month and
 * `partitionMonthsAhead` more, plus every month for which rows were parked in the default partition. Two runs at once
 * are serialised by an advisory lock, so the second finds the partitions and adds nothing. A message whose month has no
 * partition is never refused: it lands in the default partition; the run moves such rows into their new partition and
 * reports what it found (log and gauge) so an alert can fire.
 */
@Injectable()
export class ChatPartitionService {
  private readonly log = new Logger(ChatPartitionService.name);

  constructor(
    @Inject(PORTS.PartitionRepository)
    private readonly partitions: PartitionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
    private readonly runner: TransactionRunner,
  ) {}

  async ensure(): Promise<PartitionRun> {
    const now = this.clock.now();
    const run = await this.runner.run(
      async () => {
        await this.partitions.lock();
        const parked = await this.partitions.defaultRows();
        const [oldest, existing] = await Promise.all([
          this.partitions.oldestDefault(),
          this.partitions.existing(),
        ]);
        const created: string[] = [];
        let moved = 0;
        for (const month of partitionMonths(
          oldest,
          now,
          this.settings.partitionMonthsAhead,
        )) {
          if (existing.has(month)) continue;
          moved += (await this.partitions.create(month)).moved;
          created.push(month);
        }
        return { created, moved, parked };
      },
      { lockTimeoutMs: 5_000 },
    );
    const defaultRows = await this.partitions.defaultRows();
    chatDefaultPartitionRowsGauge.set(defaultRows);
    if (run.parked > 0) {
      this.log.warn(
        `chat.partition-maintenance found ${run.parked} message(s) in the default partition; moved ${run.moved}, ${defaultRows} left`,
      );
    }
    return { created: run.created, moved: run.moved, defaultRows };
  }
}
