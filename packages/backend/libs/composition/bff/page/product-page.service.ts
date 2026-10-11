import { Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type {
  PageQuery,
  ProductPageResponse,
  SectionError,
  SectionName,
} from '@marketplace-sandbox/contracts';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { BffSettings } from '../bff-config';
import { outcomeLabel, recordPageMetrics } from './page-metrics';
import type { Credentials } from '../credentials/credentials';
import { BffProblem } from '../problem';
import { CurrentRequest } from '../request-id';
import { UpstreamClient } from '../upstream/upstream-client';
import { classify, UpstreamFailure } from '../upstream/upstream-error';
import type { SectionOutcome } from './section-outcome';
import {
  SECTION_REGISTRY,
  SectionContext,
  SectionDefinition,
} from './section-registry';

type Product = ProductPageResponse['product'];

export type { SectionOutcome };

export interface PageResult {
  body: ProductPageResponse;
  outcomes: SectionOutcome[];
  durationMs: number;
}

/** Share of the product budget a second attempt needs to be worth starting (S48 FR-007). */
const MIN_RETRY_BUDGET_MS = 300;
const RETRY_BACKOFF = { baseMs: 50, maxMs: 200 };
/** HTTP statuses of the product call that justify the single retry (connection reset and timeout have none). */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/**
 * The product-page aggregate (S48 FR-001..FR-012). Two waves under one overall deadline and one `AbortController`:
 * the product and every section that needs only its id start together; `shop` and `trending` start the moment the
 * product answered. A required failure (or an upstream `401` on a credentialed call) ends the request at once and
 * aborts what is still outstanding. Optional sections degrade to `null` plus `{section, code, retryable}`.
 */
@Injectable()
export class ProductPageService {
  private readonly logger = new Logger(ProductPageService.name);

  constructor(
    private readonly upstream: UpstreamClient,
    private readonly settings: BffSettings,
    private readonly request: CurrentRequest,
  ) {}

  async load(args: {
    productId: string;
    query: PageQuery;
    credentials: Credentials;
    /** Aborts everything when the client goes away. */
    signal?: AbortSignal;
  }): Promise<PageResult> {
    const started = performance.now();
    const deadlineAt = started + this.settings.pageDeadlineMs;
    const controller = new AbortController();
    args.signal?.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
    const slots = this.upstream.gate.forRequest();

    let rejectFatal!: (problem: BffProblem) => void;
    const fatal = new Promise<never>((_, reject) => (rejectFatal = reject));
    fatal.catch(() => undefined);

    const baseContext: SectionContext = {
      productId: args.productId,
      query: args.query,
      credentials: args.credentials,
    };

    const run = async (
      def: SectionDefinition,
      context: SectionContext,
    ): Promise<SectionOutcome> => {
      const endpoint = def.endpoint(context);
      if (!endpoint)
        return {
          name: def.name,
          status: 'skipped',
          value: null,
          durationMs: 0,
        };
      const sectionStarted = performance.now();
      try {
        const body = def.required
          ? await this.callRequired(
              def,
              endpoint,
              context,
              slots,
              controller.signal,
              deadlineAt,
            )
          : (
              await this.upstream.call(endpoint, {
                credentials: context.credentials,
                slots,
                signal: controller.signal,
                ...this.budgetFor(def.name, deadlineAt),
              })
            ).body;
        return {
          name: def.name,
          status: 'ok',
          value: def.shape(body),
          durationMs: performance.now() - sectionStarted,
        };
      } catch (error) {
        const failure = classify(error);
        if (def.required && !failure.aborted)
          rejectFatal(this.requiredProblem(failure));
        else if (failure.unauthorized)
          rejectFatal(new BffProblem('invalid_token'));
        return {
          name: def.name,
          status: 'error',
          value: null,
          failure,
          durationMs: performance.now() - sectionStarted,
        };
      }
    };

    const defs = SECTION_REGISTRY;
    const productDef = defs.find((d) => d.required)!;
    const afterProductDefs = defs.filter(
      (d) => !d.required && d.dependsOn === 'product',
    );
    const withProductIdDefs = defs.filter(
      (d) => !d.required && d.dependsOn === 'productId',
    );

    const productP = run(productDef, baseContext);
    const earlyP = withProductIdDefs.map((d) => run(d, baseContext));
    const laterP = productP.then((outcome) => {
      if (outcome.status !== 'ok') return [] as SectionOutcome[];
      const context = { ...baseContext, product: outcome.value as Product };
      return Promise.all(afterProductDefs.map((d) => run(d, context)));
    });

    let outcomes: SectionOutcome[];
    try {
      const [product, early, later] = await Promise.race([
        Promise.all([productP, Promise.all(earlyP), laterP]),
        fatal,
      ]);
      if (product.status !== 'ok') throw new BffProblem('upstream_unavailable');
      outcomes = [product, ...early, ...later];
    } catch (problem) {
      controller.abort(); // nothing outstanding may keep working after the answer
      this.logPage(problem instanceof BffProblem ? problem.status : 500, []);
      throw problem;
    }
    controller.abort();

    const byName = new Map(outcomes.map((o) => [o.name, o]));
    const ordered = defs.map((d) => byName.get(d.name)!).filter(Boolean);
    const errors: SectionError[] = ordered.flatMap((o) =>
      o.status === 'error'
        ? [
            {
              section: o.name,
              code: o.failure.code,
              retryable: o.failure.retryable,
            },
          ]
        : [],
    );
    const value = (name: SectionName) =>
      (byName.get(name)?.value ?? null) as never;
    const body: ProductPageResponse = {
      product: value('product'),
      shop: value('shop'),
      recommendations: value('recommendations'),
      trending: value('trending'),
      flags: value('flags'),
      chatUnread: value('chatUnread'),
      discussions: value('discussions'),
      videos: value('videos'),
      gallery: value('gallery'),
      pickup: value('pickup'),
      flashSale: value('flashSale'),
      auction: value('auction'),
      errors,
    };
    recordPageMetrics(ordered);
    this.logPage(200, ordered);
    return { body, outcomes: ordered, durationMs: performance.now() - started };
  }

  /** One structured line per request: request id and section outcomes, never a token, cookie, e-mail or body (AS-23). */
  private logPage(status: number, outcomes: readonly SectionOutcome[]): void {
    this.logger.log(
      JSON.stringify({
        event: 'product_page',
        requestId: this.request.requestId,
        status,
        sections: Object.fromEntries(
          outcomes.map((o) => [o.name, outcomeLabel(o)]),
        ),
      }),
    );
  }

  /** `min(own budget, time left)`; a budget cut by the deadline turns a timeout into `BUDGET_EXCEEDED`. */
  private budgetFor(name: SectionName, deadlineAt: number) {
    const own = this.settings.budgetsMs[name];
    const left = deadlineAt - performance.now();
    return { budgetMs: Math.min(own, left), deadlineLimited: left <= own };
  }

  /** The product call: one retry with full-jitter backoff while at least 300 ms of its budget remain. */
  private async callRequired(
    def: SectionDefinition,
    endpoint: NonNullable<ReturnType<SectionDefinition['endpoint']>>,
    context: SectionContext,
    slots: ReturnType<UpstreamClient['gate']['forRequest']>,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<unknown> {
    const own = this.settings.budgetsMs[def.name];
    const startedAt = performance.now();
    for (let attempt = 0; ; attempt++) {
      const spent = performance.now() - startedAt;
      const budget = this.budgetFor(def.name, deadlineAt);
      try {
        return (
          await this.upstream.call(endpoint, {
            credentials: context.credentials,
            slots,
            signal,
            budgetMs: Math.min(budget.budgetMs, own - spent),
            deadlineLimited: budget.deadlineLimited,
          })
        ).body;
      } catch (error) {
        const failure = classify(error);
        const retryable =
          (failure.code === 'UPSTREAM_TIMEOUT' ||
            (failure.code === 'UPSTREAM_UNAVAILABLE' &&
              (failure.status === undefined ||
                RETRYABLE_STATUS.has(failure.status)))) &&
          !failure.aborted;
        const remaining = own - (performance.now() - startedAt);
        if (attempt > 0 || !retryable || remaining < MIN_RETRY_BUDGET_MS)
          throw failure;
        await sleep(fullJitterBackoff(attempt, RETRY_BACKOFF), signal);
      }
    }
  }

  /** The required product failed: the page answer (FR-006). */
  private requiredProblem(failure: UpstreamFailure): BffProblem {
    switch (failure.code) {
      case 'UPSTREAM_NOT_FOUND':
        return new BffProblem('not_found');
      case 'UPSTREAM_INVALID':
        return new BffProblem('upstream_invalid');
      case 'UPSTREAM_OVERLOADED':
        return new BffProblem('overloaded', { retryAfterSeconds: 1 });
      default:
        return new BffProblem('upstream_unavailable', {
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((failure.retryAfterMs ?? 1_000) / 1_000),
          ),
        });
    }
  }
}
