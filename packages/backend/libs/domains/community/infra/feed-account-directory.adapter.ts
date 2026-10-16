import { Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { UserDirectoryService } from '@app/domains/identity';
import { feedUnavailable } from '../domain/feed-errors';
import type { FeedAccountDirectory } from '../domain/ports';
import { withTimeout } from '../domain/with-timeout';

/**
 * Anti-corruption adapter over identity's exported directory (S01 R1, IV.8): the only importer of
 * `UserDirectoryService` in the feed. Unknown and deleted users are absent; a failure or a timeout is
 * `503 feed_unavailable` (A1).
 */
@Injectable()
export class FeedAccountDirectoryAdapter implements FeedAccountDirectory {
  private readonly logger = new Logger(FeedAccountDirectoryAdapter.name);

  constructor(
    private readonly users: UserDirectoryService,
    private readonly config: ApiConfigService,
  ) {}

  async existing(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    try {
      const found = await withTimeout(
        this.users.getUsersByIds(userIds),
        this.config.get('feed_directory_timeout_ms'),
        () => new Error('directory timeout'),
      );
      return new Set(found.keys());
    } catch (error) {
      this.logger.warn(`user lookup failed cause=${(error as Error).name}`);
      throw feedUnavailable();
    }
  }
}
