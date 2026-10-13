import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EXISTENCE_FILTER,
  LINK_REPOSITORY,
  type ExistenceFilter,
  type LinkRepository,
} from '../domain/ports';

const PAGE_SIZE = 500;

export type RebuildResult =
  { status: 'rebuilt'; codes: number } | { status: 'skipped' };

/**
 * Rebuild of the existence filter (S37 G9, AS-33): re-adds every stored code in table pages, sets the *ready* marker
 * last, and runs once at a time across replicas (a lock; a second start is a no-op). Safe to rerun: adding a code
 * twice changes nothing. The same scan backfills rows written before S37 (`sk`, `status`, `kind`, `updatedAt`).
 */
@Injectable()
export class FilterRebuildService {
  private readonly logger = new Logger(FilterRebuildService.name);

  constructor(
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(EXISTENCE_FILTER) private readonly filter: ExistenceFilter,
  ) {}

  async rebuild(): Promise<RebuildResult> {
    if (!(await this.filter.tryLockRebuild())) return { status: 'skipped' };
    try {
      let codes = 0;
      let next: unknown;
      do {
        const page = await this.links.scanCodes(PAGE_SIZE, next);
        await this.filter.addMany(page.codes);
        codes += page.codes.length;
        next = page.next;
      } while (next);
      await this.filter.markReady();
      this.logger.log(`existence filter rebuilt (${codes} codes)`);
      return { status: 'rebuilt', codes };
    } finally {
      await this.filter.unlockRebuild().catch(() => undefined);
    }
  }
}
