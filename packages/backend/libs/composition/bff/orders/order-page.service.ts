import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type {
  OrderPageError,
  OrderPageResponse,
} from '@marketplace-sandbox/contracts';
import { BffSettings } from '../bff-config';
import { tokenOf, type Credentials } from '../credentials/credentials';
import { requiredFailureProblem } from '../page/required-failure';
import { BffProblem } from '../problem';
import { orderById } from '../upstream/endpoints/orders';
import { latestPaymentOf } from '../upstream/endpoints/payments';
import { UpstreamClient } from '../upstream/upstream-client';
import { classify } from '../upstream/upstream-error';

/** Budget of the optional payment call (no configured section of its own). */
const PAYMENT_BUDGET_MS = 500;

/**
 * W03 B-4: the buyer's order plus its latest payment. The order read is required: its `404`/`400`/`401` pass through.
 * The payment is optional: none yet is `payment: null` without an error, a failed read is `payment: null` plus an
 * error entry. The provider secret is never copied (the payment shape is picked field by field).
 */
@Injectable()
export class OrderPageService {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly settings: BffSettings,
  ) {}

  async load(args: {
    orderId: string;
    credentials: Credentials;
    signal?: AbortSignal;
  }): Promise<OrderPageResponse> {
    if (!tokenOf(args.credentials)) throw new BffProblem('unauthenticated');
    const deadlineAt = performance.now() + this.settings.pageDeadlineMs;
    const slots = this.upstream.gate.forRequest();
    const controller = new AbortController();
    args.signal?.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
    const ctx = (own: number) => {
      const left = deadlineAt - performance.now();
      return {
        credentials: args.credentials,
        slots,
        signal: controller.signal,
        budgetMs: Math.min(own, left),
        deadlineLimited: left <= own,
      };
    };

    const paymentP = this.upstream
      .call(latestPaymentOf(args.orderId), ctx(PAYMENT_BUDGET_MS))
      .then(
        (r) => ({ ok: true as const, page: r.body }),
        (error: unknown) => ({ ok: false as const, failure: classify(error) }),
      );
    try {
      const order = (
        await this.upstream.call(
          orderById(args.orderId),
          ctx(this.settings.budgetsMs.product),
        )
      ).body;
      const outcome = await paymentP;
      const errors: OrderPageError[] = [];
      let payment: OrderPageResponse['payment'] = null;
      if (outcome.ok) {
        const latest = outcome.page.items[0];
        if (latest)
          payment = {
            id: latest.id,
            status: latest.status,
            amountMinor: latest.amountMinor,
            currency: latest.currency,
            failureCode: latest.failureCode,
            requiresAction: latest.requiresAction,
            version: latest.version,
            updatedAt: latest.updatedAt,
          };
      } else if (outcome.failure.unauthorized) {
        throw requiredFailureProblem(outcome.failure);
      } else if (!outcome.failure.aborted) {
        errors.push({
          section: 'payment',
          code: outcome.failure.code,
          retryable: outcome.failure.retryable,
        });
      }
      return { order, payment, errors };
    } catch (error) {
      if (error instanceof BffProblem) throw error;
      throw requiredFailureProblem(classify(error));
    } finally {
      controller.abort(); // nothing outstanding may keep working after the answer
    }
  }
}
