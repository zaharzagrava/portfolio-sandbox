import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EntitlementsService } from '@app/domains/billing';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { assistantRatePolicies } from '../rate-limit-policies';
import {
  Domain_AssistantBusy,
  Domain_AssistantQuotaExceeded,
} from './assistant-errors';

const DEFAULT_BUYER_TOKENS_PER_MONTH = 200_000;

const monthOf = (d = new Date()) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const usedKey = (userId: string, month = monthOf()) =>
  `assistant:tokens:{${userId}}:${month}`;

/**
 * Three layers (10/10 #42), cheapest check first:
 *  1. requests/min per user - `@RateLimit('llm.messages')` on the route,
 *  2. monthly token allowance per user from entitlements (plan), counted in
 *     Redis as turns finish (exact enough for a soft cap; ClickHouse
 *     usage_events stays the billing truth),
 *  3. the provider's fleet-wide tokens/min bucket per model, taken with the
 *     estimated request size, so one busy minute degrades into fast 429s
 *     instead of provider 429s after a slow round trip.
 */
@Injectable()
export class AssistantQuotaService {
  constructor(
    private readonly redis: RedisService,
    private readonly entitlements: EntitlementsService,
    private readonly limiter: RateLimiterService,
    private readonly config: ApiConfigService,
  ) {}

  async allowance(userId: string): Promise<number> {
    const ent = await this.entitlements.get('USER', userId);
    return (
      ent.assistantTokensPerMonth ??
      Number(
        this.config.get('assistant_buyer_tokens_per_month') ??
          DEFAULT_BUYER_TOKENS_PER_MONTH,
      )
    );
  }

  async usage(userId: string): Promise<{ used: number; allowance: number }> {
    const [used, allowance] = await Promise.all([
      this.redis.client.get(usedKey(userId)),
      this.allowance(userId),
    ]);
    return { used: Number(used ?? 0), allowance };
  }

  async assertMonthly(userId: string): Promise<void> {
    const { used, allowance } = await this.usage(userId);
    if (used >= allowance) {
      const now = new Date();
      const nextMonth = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + 1,
        1,
      );
      throw new Domain_AssistantQuotaExceeded(nextMonth - now.getTime());
    }
  }

  async takeProviderBudget(
    model: string,
    estimatedTokens: number,
  ): Promise<void> {
    const cost = Math.min(
      assistantRatePolicies.policies['llm.provider.tpm'].limit,
      Math.max(1, estimatedTokens),
    );
    const decision = await this.limiter.check('llm.provider.tpm', model, cost);
    if (!decision.allowed)
      throw new Domain_AssistantBusy(decision.retryAfterMs ?? 0);
  }

  async charge(userId: string, tokens: number): Promise<void> {
    const key = usedKey(userId);
    await this.redis.client
      .multi()
      .incrby(key, tokens)
      .pexpire(key, 40 * 86_400_000)
      .exec();
  }
}
