import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { BACKFILL_STORE, type BackfillStore } from '../domain/ports';

export type BackfillPhase = 'boards' | 'threads';

const PAGE = 500;

/** One page of the one-shot expand step per call; the job re-enqueues itself with the returned page state. */
@Injectable()
export class BackfillService {
  constructor(
    @Inject(BACKFILL_STORE) private readonly store: BackfillStore,
    private readonly config: ApiConfigService,
  ) {}

  async step(
    phase: BackfillPhase,
    pageState: string | null,
  ): Promise<{
    phase: BackfillPhase;
    next: string | null;
    done: boolean;
    rows: number;
  }> {
    const result =
      phase === 'boards'
        ? await this.store.boardMonths(pageState, PAGE)
        : await this.store.threadRoots(
            pageState,
            PAGE,
            this.config.get('discussions_partition_size'),
          );
    if (result.next)
      return { phase, next: result.next, done: false, rows: result.rows };
    if (phase === 'boards')
      return { phase: 'threads', next: null, done: false, rows: result.rows };
    return { phase, next: null, done: true, rows: result.rows };
  }
}
