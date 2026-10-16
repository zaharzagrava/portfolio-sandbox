import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import type { TransitionRepository } from '../domain/ports';
import type { StoryStatus, TransitionAction } from '../domain/story-status';
import { exec } from './sql';

/** `StoryTransition` (own table): one history row per status or schedule change, in the transaction of the change. */
@Injectable()
export class SequelizeTransitionRepository implements TransitionRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async record(input: {
    shopId: string;
    storyId: string;
    from: StoryStatus | null;
    to: StoryStatus;
    action: TransitionAction;
    actor: string | null;
    now: Date;
  }): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO "StoryTransition" ("id", "shopId", "storyId", "from", "to", "action", "actor", "occurredAt")
       VALUES ($id, $shopId, $storyId, $from, $to, $action, $actor::uuid, $now)`,
      { ...input, id: uuidv7() },
    );
  }
}
