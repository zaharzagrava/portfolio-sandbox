import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { RequestContext } from '@app/infrastructure/context';
import {
  ACTIVE_SET_CACHE,
  FUNCTION_REPOSITORY,
  type ActiveFunction,
  type ActiveSetCache,
  type FunctionRepository,
} from '../domain/ports';
import { functionsLog } from './functions-log';

/** `unavailable` = the stored definitions of that shop could not be read. */
export type ActiveSetResult = ActiveFunction[] | 'unavailable';

/**
 * The enabled functions with an active version per shop (S45 FR-031): cache-aside with a 60 s TTL, one query for every
 * shop that missed. A cache failure or a corrupt entry reads the stored definitions; only a failure of the store itself
 * makes a shop's definitions unavailable. The source never reaches a log line.
 */
@Injectable()
export class ActiveSetService {
  private readonly logger = new Logger(ActiveSetService.name);

  constructor(
    @Inject(ACTIVE_SET_CACHE) private readonly cache: ActiveSetCache,
    @Inject(FUNCTION_REPOSITORY) private readonly functions: FunctionRepository,
    @Optional() private readonly context?: RequestContext,
  ) {}

  async load(shopIds: string[]): Promise<Map<string, ActiveSetResult>> {
    const result = new Map<string, ActiveSetResult>();
    let cached = new Map<string, ActiveFunction[]>();
    try {
      cached = await this.cache.getMany(shopIds);
    } catch {
      functionsLog(
        this.logger,
        this.context,
        'warn',
        'active_set_cache_unavailable',
      );
    }
    for (const [shopId, set] of cached) result.set(shopId, set);

    const missing = shopIds.filter((id) => !result.has(id));
    if (missing.length === 0) return result;
    let rows: ActiveFunction[];
    try {
      rows = await this.functions.activeFor(missing);
    } catch {
      functionsLog(
        this.logger,
        this.context,
        'warn',
        'definitions_unavailable',
      );
      for (const shopId of missing) result.set(shopId, 'unavailable');
      return result;
    }
    const fresh = new Map<string, ActiveFunction[]>(
      missing.map((id) => [id, []]),
    );
    for (const row of rows) fresh.get(row.shopId)?.push(row);
    for (const [shopId, set] of fresh) result.set(shopId, set);
    try {
      await this.cache.setMany(fresh);
    } catch {
      functionsLog(
        this.logger,
        this.context,
        'warn',
        'active_set_cache_write_failed',
      );
    }
    return result;
  }
}
