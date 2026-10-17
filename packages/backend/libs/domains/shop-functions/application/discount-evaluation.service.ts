import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RequestContext } from '@app/infrastructure/context';
import { functionDiscounts, shopDiscount } from '../domain/discount-amount';
import type { FunctionInput } from '../domain/contract';
import {
  MEMO_CACHE,
  SANDBOX,
  SHOP_FUNCTIONS_ENTITLEMENTS,
  type ActiveFunction,
  type MemoCache,
  type Sandbox,
  type ShopFunctionsEntitlements,
} from '../domain/ports';
import { ActiveSetService } from './active-set.service';
import { BreakerService } from './breaker.service';
import {
  discountCartSchema,
  MAX_CART_SHOPS,
  type DiscountCartDto,
  type DiscountEvaluationDto,
} from './discount-evaluation.dto';
import { functionsLog } from './functions-log';
import { ShopFunctionsConfig } from './shop-functions.config';
import {
  shopFunctionsMetrics,
  type EvaluationOutcome,
} from './shop-functions.metrics';

type CartLine = DiscountCartDto['lines'][number];

const EMPTY: DiscountEvaluationDto = { shopDiscounts: [] };

/**
 * Discount evaluation at checkout, exported to orders (S45 FR-025..FR-032). One integer amount per shop; it NEVER
 * rejects: any failure of an entitlement lookup, the stored definitions, the cache, the breaker, the runtime or the
 * function itself costs the buyer nothing and the seller only that discount. Each function gets 5 ms, the whole call
 * 200 ms; shops run in parallel and a shop's functions in name order.
 */
@Injectable()
export class DiscountEvaluationService {
  private readonly logger = new Logger(DiscountEvaluationService.name);

  constructor(
    @Inject(SHOP_FUNCTIONS_ENTITLEMENTS)
    private readonly entitlements: ShopFunctionsEntitlements,
    @Inject(SANDBOX) private readonly sandbox: Sandbox,
    @Inject(MEMO_CACHE) private readonly memo: MemoCache,
    private readonly activeSets: ActiveSetService,
    private readonly breakers: BreakerService,
    private readonly config: ShopFunctionsConfig,
    @Optional() private readonly context?: RequestContext,
  ) {}

  async evaluateDiscounts(
    cart: DiscountCartDto,
  ): Promise<DiscountEvaluationDto> {
    const started = performance.now();
    try {
      return await this.evaluate(cart, started);
    } catch (error) {
      // Defence in depth: nothing above should throw, and the checkout must not learn if it does.
      functionsLog(this.logger, this.context, 'error', 'evaluation_failed', {
        error: (error as Error)?.name ?? 'Error',
      });
      return EMPTY;
    } finally {
      try {
        shopFunctionsMetrics.evaluationDuration(performance.now() - started);
      } catch {
        // metrics never fail a checkout
      }
    }
  }

  private async evaluate(
    cart: DiscountCartDto,
    started: number,
  ): Promise<DiscountEvaluationDto> {
    const parsed = discountCartSchema.safeParse(cart);
    const shopIds = parsed.success
      ? [...new Set(parsed.data.lines.map((l) => l.shopId))]
      : [];
    if (!parsed.success || shopIds.length > MAX_CART_SHOPS) {
      shopFunctionsMetrics.evaluation('invalid_cart');
      functionsLog(this.logger, this.context, 'warn', 'invalid_cart');
      return EMPTY;
    }
    const { currency, lines } = parsed.data;

    let entitled: Map<string, boolean>;
    try {
      entitled = await this.entitlements.getMany(shopIds);
    } catch {
      shopIds.forEach(() =>
        shopFunctionsMetrics.evaluation('entitlement_unavailable'),
      );
      functionsLog(
        this.logger,
        this.context,
        'warn',
        'entitlement_unavailable',
      );
      return EMPTY;
    }
    const entitledShops = shopIds.filter((id) => entitled.get(id) === true);
    for (const id of shopIds)
      if (!entitled.get(id)) shopFunctionsMetrics.evaluation('not_entitled');
    if (entitledShops.length === 0) return EMPTY;

    const sets = await this.activeSets.load(entitledShops);
    const deadline = started + this.config.callBudgetMs;
    const amounts = new Map<string, number>();
    const work = entitledShops.map(async (shopId) => {
      const set = sets.get(shopId);
      if (set === 'unavailable' || !set) {
        shopFunctionsMetrics.evaluation('definitions_unavailable');
        return;
      }
      if (set.length === 0) return;
      const shopLines = lines.filter((l) => l.shopId === shopId);
      const amount = await this.evaluateShop(
        currency,
        shopLines,
        set,
        deadline,
      );
      if (amount > 0 && performance.now() <= deadline)
        amounts.set(shopId, amount);
    });
    const finished = new Set<string>();
    const tracked = work.map((promise, i) =>
      promise.then(
        () => void finished.add(entitledShops[i]),
        () => void finished.add(entitledShops[i]),
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
    });
    await Promise.race([Promise.all(tracked), budget]);
    clearTimeout(timer);

    const result: DiscountEvaluationDto['shopDiscounts'] = [];
    for (const shopId of entitledShops) {
      if (!finished.has(shopId)) {
        shopFunctionsMetrics.evaluation('budget_exceeded');
        continue;
      }
      const amount = amounts.get(shopId);
      if (amount && amount > 0) result.push({ shopId, discountMinor: amount });
    }
    return { shopDiscounts: result };
  }

  /** The shop's amount: functions in name order, largest discount per line wins. Never throws. */
  private async evaluateShop(
    currency: string,
    shopLines: CartLine[],
    functions: ActiveFunction[],
    deadline: number,
  ): Promise<number> {
    const input: FunctionInput = {
      currency,
      lines: shopLines.map((l) => ({
        productId: l.productId,
        category: l.category,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
      })),
    };
    const canonical = JSON.stringify(input);
    const inputHash = createHash('sha256').update(canonical).digest('hex');
    const vectors: number[][] = [];
    for (const fn of functions) {
      // The call is answered at its deadline: work for a shop that was given up on does not start another function.
      if (performance.now() > deadline) break;
      try {
        const vector = await this.evaluateFunction(
          fn,
          input,
          inputHash,
          shopLines,
        );
        if (vector) vectors.push(vector);
      } catch {
        shopFunctionsMetrics.evaluation('runtime');
      }
    }
    return shopDiscount(shopLines, vectors);
  }

  private async evaluateFunction(
    fn: ActiveFunction,
    input: FunctionInput,
    inputHash: string,
    shopLines: CartLine[],
  ): Promise<number[] | null> {
    const admission = await this.breakers.admit(fn.id);
    if (admission === 'SKIP') {
      shopFunctionsMetrics.evaluation('breaker_open');
      return null;
    }
    const memoKey = `shopfn:memo:${fn.id}:${fn.version}:${inputHash}`;
    let vector = await this.memo.get(memoKey).catch(() => null);
    if (!vector || vector.length !== shopLines.length) {
      const res = await this.sandbox.run(
        fn.source,
        input,
        this.config.functionBudgetMs,
      );
      if (!res.ok) {
        const outcome = failureOutcome(res.error);
        shopFunctionsMetrics.evaluation(outcome);
        functionsLog(this.logger, this.context, 'warn', 'function_failed', {
          outcome,
        });
        await this.breakers.failure(fn.id, outcome);
        return null;
      }
      vector = functionDiscounts(shopLines, res.output);
      if (!vector) {
        shopFunctionsMetrics.evaluation('invalid_output');
        functionsLog(this.logger, this.context, 'warn', 'function_failed', {
          outcome: 'invalid_output',
        });
        await this.breakers.failure(fn.id, 'invalid_output');
        return null;
      }
      await this.memo.set(memoKey, vector).catch(() => undefined);
    }
    await this.breakers.success(fn.id);
    shopFunctionsMetrics.evaluation(
      vector.some((n) => n > 0) ? 'applied' : 'no_discount',
    );
    return vector;
  }
}

function failureOutcome(error: string): EvaluationOutcome {
  switch (error) {
    case 'timeout':
      return 'timeout';
    case 'memory':
      return 'memory';
    case 'invalid-output':
      return 'invalid_output';
    default:
      return 'runtime';
  }
}
