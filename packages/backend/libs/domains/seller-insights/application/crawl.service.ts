import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { SafeRequestError } from '@app/infrastructure/net';
import { extractPrice } from '../domain/extract-price';
import { isAllowed, parseRobots, capCrawlDelayMs } from '../domain/robots';
import {
  hostBackoffMs,
  nextIntervalMs,
  parseRetryAfter,
  statusFromHttp,
  type CrawlStatus,
} from '../domain/schedule';
import { simhash, simhashDistance, visibleText } from '../domain/simhash';
import { ObservationHistoryUnavailable } from '../domain/competitor-errors';
import {
  FRONTIER,
  OBSERVATION_HISTORY,
  PAGE_ARCHIVE,
  ROBOTS_CACHE,
  SAFE_FETCHER,
  TARGET_REPOSITORY,
  WATCH_REPOSITORY,
  type FetchResult,
  type FrontierPort,
  type ObservationHistory,
  type PageArchive,
  type RobotsCache,
  type SafeFetcher,
  type TargetRecord,
  type TargetRepository,
  type WatchRepository,
} from '../domain/crawler-ports';
import {
  CompetitorEvaluationService,
  EVALUATION_BATCH,
} from './competitor-evaluation.service';
import {
  CRAWL_BUDGET_MS,
  MAX_CRAWL_DELAY_MS,
  ROBOTS_TTL_SECONDS,
} from './crawl.constants';
import { CrawlerConfig } from './crawler.config';
import { crawlerMetrics } from './crawler.metrics';

/** Pages within this many bits of the stored fingerprint are the same page (FR-022). */
const UNCHANGED_BITS = 3;
/** Failures of the target itself (not the host) that walk the error ladder. */
const LADDER_STATUSES: ReadonlySet<CrawlStatus> = new Set<CrawlStatus>([
  'gone',
  'http_5xx',
  'network_error',
  'timeout',
  'unresolvable',
  'tls_error',
]);
/** Kinds from the robots request that end the crawl with the kind itself rather than `robots_unavailable`. */
const ROBOTS_FATAL: ReadonlySet<string> = new Set([
  'blocked_address',
  'invalid_url',
  'unresolvable',
]);

type Robots = (
  | { kind: 'rules'; rules: ReturnType<typeof parseRobots> }
  | { kind: 'allow_all' }
  | { kind: 'unavailable' }
  | { kind: 'fatal'; status: CrawlStatus }
) & {
  /** robots.txt was requested during this crawl (not served by the fleet cache). */
  fetched?: boolean;
};

export interface CrawlOutcome {
  /** How long the host is left alone before its next request. */
  delayMs: number;
  /** The status recorded on the target, `null` when the target was gone or retired. */
  status: CrawlStatus | null;
}

const originOf = (url: URL) =>
  `${url.protocol}//${url.hostname}:${url.port || '443'}`;
const pathOf = (url: URL) => `${url.pathname}${url.search}`;
const datePart = (at: Date) => at.toISOString().slice(0, 10);

/**
 * One crawl of one target (S41 US3, US4): robots.txt through the fleet cache, the page through the SSRF-safe fetcher
 * inside a 30 s budget, extraction and fingerprint, then either an outcome (status and next check) or an observation
 * (history row, then one transaction that advances the counter and evaluates the first batch of watches). Nothing here
 * logs a URL, query, body or resolved address.
 */
@Injectable()
export class CrawlService {
  private readonly logger = new Logger(CrawlService.name);

  constructor(
    @Inject(TARGET_REPOSITORY) private readonly targets: TargetRepository,
    @Inject(WATCH_REPOSITORY) private readonly watches: WatchRepository,
    @Inject(ROBOTS_CACHE) private readonly robotsCache: RobotsCache,
    @Inject(SAFE_FETCHER) private readonly fetcher: SafeFetcher,
    @Inject(OBSERVATION_HISTORY) private readonly history: ObservationHistory,
    @Inject(PAGE_ARCHIVE) private readonly archive: PageArchive,
    @Inject(FRONTIER) private readonly frontier: FrontierPort,
    private readonly evaluation: CompetitorEvaluationService,
    private readonly transactions: TransactionRunner,
    private readonly config: CrawlerConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The jitter source; a spec replaces it to pin an interval. */
  random: () => number = Math.random;
  /** Waits out the politeness gap between a fresh robots.txt request and the page request; a spec replaces it to run fast. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** One fetcher iteration: take a ready target, crawl it, give the host back. `false` when nothing is ready. */
  async crawlNext(onTaken?: (host: string) => () => void): Promise<boolean> {
    const next = await this.frontier.take();
    if (!next) return false;
    const done = onTaken?.(next.host);
    const crawlId = uuidv7();
    let delayMs = this.config.settings.minGapMs;
    try {
      delayMs = (await this.crawl(next.targetId, crawlId)).delayMs;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'crawl_failed',
          crawlId,
          targetId: next.targetId,
          host: next.host,
          error: (error as Error).name,
        }),
      );
      await this.settleFailure(next.targetId).catch(() => undefined);
    } finally {
      await this.frontier.release(next.host, delayMs).catch(() => undefined);
      await this.frontier.unmark(next.targetId).catch(() => undefined);
      done?.();
    }
    return true;
  }

  async crawl(targetId: string, crawlId = uuidv7()): Promise<CrawlOutcome> {
    const minGap = this.config.settings.minGapMs;
    const target = await this.targets.findById(targetId);
    if (!target || target.retiredAt || (await this.unwatched(target)))
      return { delayMs: minGap, status: null };
    const started = Date.now();
    const remaining = () => CRAWL_BUDGET_MS - (Date.now() - started);
    const url = new URL(target.url);

    const robots = await this.robots(url, remaining);
    if (robots.kind === 'fatal')
      return this.fail(target, robots.status, minGap);
    if (robots.kind === 'unavailable')
      return this.fail(target, 'robots_unavailable', minGap);
    const delayMs = Math.min(
      MAX_CRAWL_DELAY_MS,
      robots.kind === 'rules' ? capCrawlDelayMs(robots.rules, minGap) : minGap,
    );
    if (robots.kind === 'rules' && !isAllowed(robots.rules, pathOf(url)))
      return this.fail(target, 'disallowed_by_robots', delayMs);
    // robots.txt and the page are two requests to one host: the gap applies between them too (FR-015)
    if (robots.fetched)
      await this.sleep(Math.min(delayMs, Math.max(0, remaining() - 10_000)));

    let res: FetchResult;
    try {
      res = await this.fetcher.get(target.url, {
        deadlineMs: Math.max(1, Math.min(10_000, remaining())),
      });
    } catch (error) {
      if (error instanceof SafeRequestError)
        return this.fail(target, error.kind, delayMs);
      throw error;
    }
    if (res.status === 429 || res.status === 503) {
      const retry = parseRetryAfter(
        String(res.headers['retry-after'] ?? ''),
        this.clock.nowMs(),
      );
      return this.fail(
        target,
        res.status === 429 ? 'http_429' : 'http_503',
        hostBackoffMs(delayMs, retry),
      );
    }
    if (res.status < 200 || res.status >= 300)
      return this.fail(target, statusFromHttp(res.status), delayMs);
    if (res.truncated) crawlerMetrics.truncated();
    return this.processPage(target, res.body, delayMs, crawlId);
  }

  // ---- robots ---------------------------------------------------------------------------------------------------

  private async robots(url: URL, remaining: () => number): Promise<Robots> {
    const origin = originOf(url);
    const now = this.clock.nowMs();
    const cached = await this.robotsCache.get(origin, now);
    if (cached) {
      crawlerMetrics.robots('hit');
      return cached.outcome === 'rules'
        ? { kind: 'rules', rules: cached.rules }
        : { kind: cached.outcome };
    }
    const put = (
      entry:
        | { outcome: 'rules'; rules: ReturnType<typeof parseRobots> }
        | { outcome: 'allow_all' }
        | { outcome: 'unavailable' },
      ttl: number,
    ) =>
      this.robotsCache.put(
        origin,
        { ...entry, expiresAt: now + ttl * 1000 },
        ttl,
      );
    let res: FetchResult;
    try {
      res = await this.fetcher.get(`${url.protocol}//${url.host}/robots.txt`, {
        robots: true,
        deadlineMs: Math.max(1, Math.min(10_000, remaining())),
      });
    } catch (error) {
      if (error instanceof SafeRequestError && ROBOTS_FATAL.has(error.kind))
        return { kind: 'fatal', status: error.kind as CrawlStatus };
      crawlerMetrics.robots('unavailable');
      await put({ outcome: 'unavailable' }, ROBOTS_TTL_SECONDS.unavailable);
      return { kind: 'unavailable' };
    }
    crawlerMetrics.robots('fetched');
    if (res.status >= 200 && res.status < 300) {
      const rules = parseRobots(
        res.body,
        'MarketplacePriceBot/1.0 (+https://marketplace.dev/bot)',
      );
      await put({ outcome: 'rules', rules }, ROBOTS_TTL_SECONDS.rules);
      return { kind: 'rules', rules, fetched: true };
    }
    if (res.status >= 400 && res.status < 500) {
      await put({ outcome: 'allow_all' }, ROBOTS_TTL_SECONDS.allowAll);
      return { kind: 'allow_all', fetched: true };
    }
    crawlerMetrics.robots('unavailable');
    await put({ outcome: 'unavailable' }, ROBOTS_TTL_SECONDS.unavailable);
    return { kind: 'unavailable' };
  }

  // ---- page -----------------------------------------------------------------------------------------------------

  private async processPage(
    target: TargetRecord,
    html: string,
    delayMs: number,
    crawlId: string,
  ): Promise<CrawlOutcome> {
    const now = this.clock.now();
    const price = extractPrice(html);
    const fingerprint = simhash(visibleText(html));
    const near =
      target.simhash !== null &&
      simhashDistance(fingerprint, target.simhash) <= UNCHANGED_BITS;

    if (price.kind !== 'price') {
      const status: CrawlStatus =
        price.kind === 'out_of_stock' ? 'out_of_stock' : 'no_price';
      const noPriceStreak = target.noPriceStreak + 1;
      const next = nextIntervalMs(
        status,
        {
          unchangedStreak: target.unchangedStreak,
          errorStreak: 0,
          noPriceStreak,
        },
        this.random,
      );
      await this.targets.recordOutcome({
        id: target.id,
        status,
        now,
        nextCheckAt: new Date(now.getTime() + next),
        noPriceStreak,
        errorStreak: 0,
        simhash: fingerprint,
      });
      if (!near) await this.archivePage(target, html, now, crawlId);
      crawlerMetrics.fetch(status);
      return { delayMs, status };
    }

    const samePrice =
      target.lastPriceMinor === price.amountMinor &&
      target.currency === price.currency;
    if (!samePrice)
      return this.observe(target, html, price, fingerprint, delayMs, crawlId);

    if (near) {
      const unchangedStreak = target.unchangedStreak + 1;
      const next = nextIntervalMs(
        'unchanged',
        { unchangedStreak, errorStreak: 0, noPriceStreak: 0 },
        this.random,
      );
      await this.targets.recordOutcome({
        id: target.id,
        status: 'unchanged',
        now,
        nextCheckAt: new Date(now.getTime() + next),
        unchangedStreak,
        errorStreak: 0,
        noPriceStreak: 0,
      });
      crawlerMetrics.fetch('unchanged');
      return { delayMs, status: 'unchanged' };
    }
    // the page changed, the price did not (AS-37): keep the page, restart the ladder
    const next = nextIntervalMs(
      'ok',
      { unchangedStreak: 0, errorStreak: 0, noPriceStreak: 0 },
      this.random,
    );
    await this.targets.recordOutcome({
      id: target.id,
      status: 'ok',
      now,
      nextCheckAt: new Date(now.getTime() + next),
      unchangedStreak: 0,
      errorStreak: 0,
      noPriceStreak: 0,
      simhash: fingerprint,
    });
    await this.archivePage(target, html, now, crawlId);
    crawlerMetrics.fetch('ok');
    return { delayMs, status: 'ok' };
  }

  /**
   * The observation step (FR-023, research D-06): the history row first (idempotent on target and counter), then one
   * transaction that advances the counter only if nobody else did and evaluates the first batch of watches, so an
   * outbox failure rolls the counter back too. The page is archived after the commit.
   */
  private async observe(
    target: TargetRecord,
    html: string,
    price: { amountMinor: number; currency: string },
    fingerprint: string,
    delayMs: number,
    crawlId: string,
  ): Promise<CrawlOutcome> {
    const now = this.clock.now();
    const expectedNo = target.observationNo;
    const firstBatch = await this.watches.pendingEvaluation(
      target.id,
      expectedNo + 1,
      EVALUATION_BATCH,
    );
    const context = await this.evaluation.prefetch(firstBatch);
    try {
      await this.history.append({
        targetId: target.id,
        observationNo: expectedNo + 1,
        observedAt: now,
        priceMinor: price.amountMinor,
        currency: price.currency,
      });
    } catch (error) {
      if (!(error instanceof ObservationHistoryUnavailable)) throw error;
      return this.failObservation(target, delayMs);
    }

    const next = nextIntervalMs(
      'ok',
      { unchangedStreak: 0, errorStreak: 0, noPriceStreak: 0 },
      this.random,
    );
    let recorded: number | null;
    try {
      recorded = await this.transactions.run(async () => {
        const no = await this.targets.recordObservation({
          id: target.id,
          expectedNo,
          priceMinor: price.amountMinor,
          currency: price.currency,
          simhash: fingerprint,
          now,
          nextCheckAt: new Date(now.getTime() + next),
        });
        if (no === null) return null;
        await this.evaluation.evaluateBatch(
          context,
          {
            id: target.id,
            host: target.host,
            observationNo: no,
            priceMinor: price.amountMinor,
            currency: price.currency,
            crawlId,
          },
          firstBatch,
        );
        return no;
      });
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'observation_rolled_back',
          crawlId,
          targetId: target.id,
          host: target.host,
          error: (error as Error).name,
        }),
      );
      return this.failObservation(target, delayMs);
    }
    if (recorded === null) return { delayMs, status: null };

    await this.archivePage(target, html, now, crawlId);
    crawlerMetrics.fetch('ok');
    await this.evaluation.evaluatePending(target.id).catch((error) =>
      this.logger.warn(
        JSON.stringify({
          event: 'evaluation_deferred',
          crawlId,
          targetId: target.id,
          host: target.host,
          error: (error as Error).name,
        }),
      ),
    );
    return { delayMs, status: 'ok' };
  }

  /** The observation could not be recorded: nothing advanced, retry in 15 minutes. */
  private async failObservation(
    target: TargetRecord,
    delayMs: number,
  ): Promise<CrawlOutcome> {
    const now = this.clock.now();
    await this.targets.recordOutcome({
      id: target.id,
      status: 'history_unavailable',
      now,
      nextCheckAt: new Date(
        now.getTime() +
          nextIntervalMs(
            'history_unavailable',
            { unchangedStreak: 0, errorStreak: 0, noPriceStreak: 0 },
            this.random,
          ),
      ),
    });
    crawlerMetrics.fetch('history_unavailable');
    return { delayMs, status: 'history_unavailable' };
  }

  private async archivePage(
    target: TargetRecord,
    html: string,
    at: Date,
    crawlId: string,
  ) {
    try {
      await this.archive.put(
        `crawl/${datePart(at)}/${target.host}/${target.id}-${at.getTime()}.html`,
        html,
      );
    } catch (error) {
      crawlerMetrics.archiveFailed();
      this.logger.warn(
        JSON.stringify({
          event: 'archive_failed',
          crawlId,
          targetId: target.id,
          host: target.host,
          error: (error as Error).name,
        }),
      );
    }
  }

  // ---- outcomes -------------------------------------------------------------------------------------------------

  /** A crawl that recorded no observation: status, streaks and the next check; price and counter stay as they were. */
  private async fail(
    target: TargetRecord,
    status: CrawlStatus,
    delayMs: number,
  ): Promise<CrawlOutcome> {
    const now = this.clock.now();
    const ladder = LADDER_STATUSES.has(status);
    const errorStreak = ladder ? target.errorStreak + 1 : target.errorStreak;
    const next = nextIntervalMs(
      status,
      {
        unchangedStreak: target.unchangedStreak,
        errorStreak,
        noPriceStreak: target.noPriceStreak,
      },
      this.random,
    );
    await this.targets.recordOutcome({
      id: target.id,
      status,
      now,
      nextCheckAt: new Date(now.getTime() + next),
      ...(ladder ? { errorStreak } : {}),
    });
    crawlerMetrics.fetch(status);
    return { delayMs, status };
  }

  /** An unexpected failure: never leave the target due, or it is queued again next minute (A11). */
  private async settleFailure(targetId: string): Promise<void> {
    const target = await this.targets.findById(targetId);
    if (target) await this.fail(target, 'network_error', 0);
  }

  private async unwatched(target: TargetRecord): Promise<boolean> {
    return (await this.watches.countActiveForTarget(target.id)) === 0;
  }
}
