import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { Balance } from '@marketplace-sandbox/contracts';
import { shopAccount } from '../domain/account';
import {
  BALANCE_DURABLE_STORE,
  BALANCE_HOT_STORE,
  BALANCE_STORE,
  type BalanceReadModelStore,
  type BalanceStore,
  type ReadModelLine,
} from '../domain/ledger-ports';

const timeout = (ms: number) =>
  new Error(`read model did not answer within ${ms} ms`);

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeout(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A shop's available balance for the endpoint (S14 FR-026, FR-027, research R-8): the hot copy, then the durable
 * copy, then the running balance in Postgres. A store that is down, slow or empty only moves the read to the next
 * step: the answer is the same number and the status never changes. Seller accounts are unsharded, so one line is
 * the whole balance. Never sums entries.
 */
@Injectable()
export class BalanceQueryService {
  private readonly logger = new Logger(BalanceQueryService.name);

  constructor(
    @Inject(BALANCE_HOT_STORE) private readonly hot: BalanceReadModelStore,
    @Inject(BALANCE_DURABLE_STORE)
    private readonly durable: BalanceReadModelStore,
    @Inject(BALANCE_STORE) private readonly balances: BalanceStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async getShopBalance(shopId: string, currency: string): Promise<Balance> {
    const accountId = shopAccount(shopId);
    const fromModel =
      (await this.fromStore(
        'hot',
        this.hot,
        accountId,
        currency,
        this.config.get('ledger_read_hot_timeout_ms'),
      )) ??
      (await this.fromStore(
        'durable',
        this.durable,
        accountId,
        currency,
        this.config.get('ledger_read_durable_timeout_ms'),
      ));
    if (fromModel)
      return {
        shopId,
        currency: 'EUR',
        availableMinor: fromModel.balanceMinor,
        asOf: fromModel.projectedAt.toISOString(),
        source: 'read_model',
      };
    const stored = await this.balances.read([accountId], currency);
    return {
      shopId,
      currency: 'EUR',
      availableMinor: stored.get(accountId) ?? 0,
      asOf: this.clock.now().toISOString(),
      source: 'ledger',
    };
  }

  private async fromStore(
    name: string,
    store: BalanceReadModelStore,
    accountId: string,
    currency: string,
    ms: number,
  ): Promise<ReadModelLine | null> {
    try {
      const lines = await within(store.get(accountId), ms);
      return (
        lines.find((l) => l.shard === 0 && l.currency === currency) ?? null
      );
    } catch (error) {
      this.logger.warn(
        `${name} balance store unavailable: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
