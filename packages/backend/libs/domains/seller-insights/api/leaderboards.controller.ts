import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { LeaderboardPage } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { insightsMetrics } from '../application/seller-insights.metrics';
import { LeaderboardReadService } from '../application/leaderboard-read.service';
import { parseTopQuery } from './query-dtos';

const LIVE_CACHE = 'public, max-age=10, s-maxage=30';
const FROZEN_CACHE = 'public, max-age=3600, s-maxage=86400';
const LIMITER_POLICY = 'seller-insights.leaderboard-read.ip';

/** The public top list (S40 US2): anonymous, rate limited per address, no revenue in any entry. */
@ApiTags('leaderboards')
@Controller()
export class LeaderboardsController {
  private limiterOutages = 0;

  constructor(private readonly reads: LeaderboardReadService) {}

  /** GET /api/leaderboards?period=week&id=2026-W40&category=electronics&limit=20 */
  @Firewall({ anonymous: true })
  @RateLimit(LIMITER_POLICY)
  @Get('leaderboards')
  async top(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeaderboardPage> {
    this.noteLimiterOutage();
    const page = await this.reads.top(parseTopQuery(req.query));
    res.setHeader(
      'Cache-Control',
      page.source === 'snapshot' ? FROZEN_CACHE : LIVE_CACHE,
    );
    return page;
  }

  /** The limiter fails open: when it served this request without its store, count it (S40 AS-21). */
  private noteLimiterOutage(): void {
    const outages =
      MetricsRegistry.value('rate_limit_store_unavailable_total', {
        policy: LIMITER_POLICY,
        fail_mode: 'open',
      }) ?? 0;
    if (outages > this.limiterOutages) {
      insightsMetrics.rateLimitDegraded();
      this.limiterOutages = outages;
    }
  }
}
