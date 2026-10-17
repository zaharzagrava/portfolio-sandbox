import { Injectable } from '@nestjs/common';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { judgeRequestTask } from '../application/events/judge-requested.event';
import type { JudgeRequests } from '../domain/ports';

/** The judge request is an outbox task appended in the caller's transaction (IV.3): committed with the version row or not at all. */
@Injectable()
export class OutboxJudgeRequests implements JudgeRequests {
  constructor(private readonly outbox: OutboxService) {}

  request(functionId: string, version: number): Promise<void> {
    return this.outbox.appendTask(judgeRequestTask({ functionId, version }));
  }
}
