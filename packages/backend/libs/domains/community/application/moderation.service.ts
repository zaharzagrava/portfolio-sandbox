import { Inject, Injectable } from '@nestjs/common';
import { serviceUnavailable, userNotFound } from '../domain/discussion-errors';
import {
  ACCOUNT_DIRECTORY,
  SHADOW_STORE,
  type AccountDirectory,
  type ShadowStore,
} from '../domain/ports';
import { DiscussionIds } from './discussion-support';

/**
 * Shadow bans (S25 US6, FR-051): `ADMIN` and `MODERATOR` mark a user's NEW content as shadow, invisible to everyone
 * but its author. Prospective: older content is untouched and lifting the ban does not reveal content made during it.
 */
@Injectable()
export class ModerationService {
  constructor(
    @Inject(SHADOW_STORE) private readonly shadow: ShadowStore,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    private readonly ids: DiscussionIds,
  ) {}

  private async assertKnown(userId: string): Promise<void> {
    let found;
    try {
      found = await this.directory.lookup([userId]);
    } catch {
      throw serviceUnavailable();
    }
    if (!found.has(userId)) throw userNotFound();
  }

  async ban(moderatorId: string, userId: string): Promise<void> {
    await this.assertKnown(userId);
    await this.shadow.ban(userId, moderatorId, this.ids.now());
  }

  async lift(userId: string): Promise<void> {
    await this.assertKnown(userId);
    await this.shadow.lift(userId);
  }
}
