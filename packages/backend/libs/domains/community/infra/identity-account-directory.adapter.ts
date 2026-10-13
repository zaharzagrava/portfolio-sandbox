import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { UserDirectoryService } from '@app/domains/identity';
import type { AccountDirectory, AccountSummary } from '../domain/ports';

/**
 * Anti-corruption adapter over identity's exported directory (S25 F1, IV.8): the only importer of
 * `UserDirectoryService` in discussions, and the only place that knows its shape. Only `id` and `createdAt` are used.
 */
@Injectable()
export class IdentityAccountDirectoryAdapter implements AccountDirectory {
  constructor(
    private readonly users: UserDirectoryService,
    private readonly config: ApiConfigService,
  ) {}

  async lookup(userIds: string[]): Promise<Map<string, AccountSummary>> {
    const timeoutMs = this.config.get('discussions_directory_timeout_ms');
    let timer: NodeJS.Timeout | undefined;
    try {
      const found = await Promise.race([
        this.users.getUsersByIds(userIds),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('directory timeout')),
            timeoutMs,
          );
        }),
      ]);
      return new Map(
        [...found].map(([id, user]) => [id, { createdAt: user.createdAt }]),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
