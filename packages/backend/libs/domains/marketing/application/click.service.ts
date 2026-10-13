import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  CLICK_LOG,
  IMPRESSION_MARKER,
  SPAM_COUNTERS,
  SPEND_COUNTER,
  type ClickLog,
  type ImpressionMarker,
  type SpamCounters,
  type SpendCounter,
} from '../domain/ads-ports';
import { adsClicksCounter } from '../domain/ads-metrics';
import {
  dayKey,
  formatReceivedAt,
  type ClickRecord,
} from '../domain/click-record';
import {
  hashAddress,
  verifyClickToken,
  type ClickClaims,
} from '../domain/click-token';
import { clickKey } from '../domain/hot-key-salt';
import { decideSpam } from '../domain/spam-filter';

export interface ClickInput {
  token: string;
  /** The client address the platform resolved from its trusted proxies; only ever hashed. */
  address: string;
  /** `false` for HEAD and prefetch: such a request resolves the target and records nothing (FR-023). */
  countable: boolean;
}

/** Where to send the shopper: the product page of a valid token, the storefront home otherwise (FR-020). */
export type ClickResult =
  { target: 'product'; productId: string } | { target: 'home' };

/**
 * `GET /ads/click/:token` (US3, US4): verify the token, make the impression count at most once, vet the click, record it,
 * and always answer with a place to redirect to. It never throws: whatever fails behind the scenes, the shopper lands on
 * the product (or home for a link that is not ours), and what cannot be vetted is recorded invalid, never billed.
 *
 * Order (R-8): verify -> dedupe marker (`SET NX`) -> exact counters (only after the marker was won, so a replay cannot
 * poison them) -> pure spam decision -> idempotent publish with a 1 s limit (the marker is removed when it fails) ->
 * spend counter. No database is read on this path (G19).
 */
@Injectable()
export class ClickService {
  private readonly logger = new Logger(ClickService.name);

  constructor(
    @Inject(IMPRESSION_MARKER) private readonly marker: ImpressionMarker,
    @Inject(SPAM_COUNTERS) private readonly counters: SpamCounters,
    @Inject(SPEND_COUNTER) private readonly spend: SpendCounter,
    @Inject(CLICK_LOG) private readonly log: ClickLog,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async handle(input: ClickInput): Promise<ClickResult> {
    const now = this.clock.now();
    const verdict = verifyClickToken(
      input.token,
      {
        current: this.config.get('ads_click_secret'),
        previous: this.config.get('ads_click_secret_previous') || undefined,
      },
      now.getTime(),
    );
    if (!verdict.ok) {
      if (input.countable)
        adsClicksCounter.add(1, {
          outcome: verdict.reason === 'expired' ? 'expired' : 'invalid_token',
        });
      return { target: 'home' };
    }
    const result: ClickResult = {
      target: 'product',
      productId: verdict.claims.p,
    };
    if (!input.countable) return result;
    try {
      await this.record(verdict.claims, input.address, now);
    } catch (error) {
      // A bug must not cost the shopper the redirect (FR-020); the click is lost, loudly.
      adsClicksCounter.add(1, { outcome: 'record_failed' });
      this.logger.error(
        `click not recorded (${(error as Error)?.name ?? 'Error'})`,
      );
    }
    return result;
  }

  private async record(
    claims: ClickClaims,
    address: string,
    now: Date,
  ): Promise<void> {
    const secret = this.config.get('ads_click_secret');
    const base = {
      click_id: claims.i,
      campaign_id: claims.c,
      shop_id: claims.s,
      product_id: claims.p,
      received_at: formatReceivedAt(now),
      ip_hash: hashAddress(secret, address),
      viewer_hash: claims.v,
    };

    // 1. The impression is counted at most once: whoever sets the marker owns it.
    try {
      if (!(await this.marker.claim(claims.i))) {
        adsClicksCounter.add(1, { outcome: 'duplicate' });
        return;
      }
    } catch {
      await this.publishUnvetted(base, claims);
      return;
    }

    // 2. Exact counters, then the pure decision.
    let reason: 'ip_burst' | 'repeat_clicker' | null;
    try {
      const counts = await this.counters.record({
        ipHash: base.ip_hash,
        viewerHash: claims.v,
        campaignId: claims.c,
        at: now,
      });
      const decision = decideSpam(counts, {
        ipPerMinute: this.config.get('ads_spam_ip_per_minute'),
        repeatPerHour: this.config.get('ads_spam_repeat_per_hour'),
      });
      reason = decision.valid ? null : decision.reason;
    } catch {
      await this.publishUnvetted(base, claims);
      return;
    }

    // 3. Record it. A failure gives the impression back so a later click can still count (the marker is removed).
    const record: ClickRecord =
      reason === null
        ? { ...base, valid: 1, invalid_reason: null }
        : { ...base, valid: 0, invalid_reason: reason };
    try {
      await this.log.publish(clickKey(claims.c, claims.i), record);
    } catch {
      adsClicksCounter.add(1, { outcome: 'record_failed' });
      await this.marker.release(claims.i).catch(() => undefined);
      return;
    }
    adsClicksCounter.add(1, { outcome: reason ?? 'counted' });

    // 4. A counted click advances today's pacing counter; losing that update only means a slightly generous slot.
    if (reason === null)
      await this.spend.increment(claims.c, dayKey(now)).catch(() => undefined);
  }

  /** The dedupe or filter store is unavailable: what cannot be vetted is recorded invalid and never billed (FR-026). */
  private async publishUnvetted(
    base: Omit<ClickRecord, 'valid' | 'invalid_reason'>,
    claims: ClickClaims,
  ): Promise<void> {
    adsClicksCounter.add(1, { outcome: 'filter_unavailable' });
    try {
      await this.log.publish(clickKey(claims.c, claims.i), {
        ...base,
        valid: 0,
        invalid_reason: 'filter_unavailable',
      });
    } catch {
      adsClicksCounter.add(1, { outcome: 'record_failed' });
    }
  }
}
