import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type {
  CartPageError,
  CartPageLine,
  CartPageResponse,
  ProductBatchItem,
} from '@marketplace-sandbox/contracts';
import { BffSettings } from '../bff-config';
import type { Credentials } from '../credentials/credentials';
import { requiredFailureProblem } from '../page/required-failure';
import { cartRead } from '../upstream/endpoints/cart';
import { productsBatch } from '../upstream/endpoints/catalog';
import { shopsBatch } from '../upstream/endpoints/tenancy';
import { UpstreamClient } from '../upstream/upstream-client';
import { classify, UpstreamFailure } from '../upstream/upstream-error';

/**
 * W03 B-3: the cart composed with product and shop summaries. The cart read is required (its failure is the answer);
 * the products and shops calls are optional sections that degrade to `null` plus `{section, code, retryable}`. A
 * product or shop the caller may not see is `null` without an error (not a failure).
 */
@Injectable()
export class CartPageService {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly settings: BffSettings,
  ) {}

  async load(args: {
    credentials: Credentials;
    guestCartCookie?: string;
    signal?: AbortSignal;
  }): Promise<CartPageResponse> {
    const deadlineAt = performance.now() + this.settings.pageDeadlineMs;
    const slots = this.upstream.gate.forRequest();
    const budget = (own: number) => {
      const left = deadlineAt - performance.now();
      return { budgetMs: Math.min(own, left), deadlineLimited: left <= own };
    };
    const ctx = (own: number) => ({
      credentials: args.credentials,
      slots,
      signal: args.signal,
      ...budget(own),
    });

    let cart;
    try {
      cart = (
        await this.upstream.call(
          cartRead(args.guestCartCookie),
          ctx(this.settings.budgetsMs.product),
        )
      ).body;
    } catch (error) {
      throw requiredFailureProblem(classify(error));
    }
    if (cart.lines.length === 0)
      return { lines: [], droppedLines: cart.droppedLines, errors: [] };

    const errors: CartPageError[] = [];
    const fail = (section: CartPageError['section'], f: UpstreamFailure) =>
      errors.push({ section, code: f.code, retryable: f.retryable });

    let products: Array<ProductBatchItem | null> = cart.lines.map(() => null);
    try {
      const found = (
        await this.upstream.call(
          productsBatch(cart.lines.map((l) => l.productId)),
          ctx(this.settings.budgetsMs.product),
        )
      ).body;
      products = cart.lines.map((_, i) => found[i] ?? null);
    } catch (error) {
      const failure = classify(error);
      if (failure.unauthorized) throw requiredFailureProblem(failure);
      fail('products', failure);
    }

    const shopIds = [
      ...new Set(products.flatMap((p) => (p ? [p.shopId] : []))),
    ];
    const shops = new Map<string, { id: string; name: string }>();
    if (shopIds.length > 0) {
      try {
        const found = (
          await this.upstream.call(
            shopsBatch(shopIds),
            ctx(this.settings.budgetsMs.shop),
          )
        ).body;
        shopIds.forEach((id, i) => {
          const shop = found[i];
          if (shop) shops.set(id, shop);
        });
      } catch (error) {
        const failure = classify(error);
        if (failure.unauthorized) throw requiredFailureProblem(failure);
        fail('shops', failure);
      }
    }

    const lines: CartPageLine[] = cart.lines.map((line, i) => {
      const product = products[i];
      const shop = product ? shops.get(product.shopId) : undefined;
      return {
        productId: line.productId,
        quantity: line.quantity,
        addedAt: line.addedAt,
        product: product
          ? {
              title: product.title,
              priceMinor: product.priceMinor,
              currency: product.currency,
              imageUrl: null,
              inStock: product.inStock,
            }
          : null,
        shop: shop ? { id: shop.id, name: shop.name } : null,
      };
    });
    return { lines, droppedLines: cart.droppedLines, errors };
  }
}
