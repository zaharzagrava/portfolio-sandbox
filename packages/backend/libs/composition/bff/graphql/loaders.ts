import DataLoader from 'dataloader';
import type { Request } from 'express';
import type { ProductBatchItem } from '@marketplace-sandbox/contracts';
import { performance } from 'node:perf_hooks';
import { BffSettings } from '../bff-config';
import type { Credentials } from '../credentials/credentials';
import { productsBatch } from '../upstream/endpoints/catalog';
import type { Endpoint } from '../upstream/endpoints/endpoint';
import { shopsBatch } from '../upstream/endpoints/tenancy';
import { UpstreamClient } from '../upstream/upstream-client';
import { loadInChunks } from './loader-batching';

type Shop = { id: string; name: string; slug: string };

export interface Loaders {
  product: DataLoader<string, ProductBatchItem | null>;
  shop: DataLoader<string, Shop | null>;
}

/** Everything one GraphQL request carries: who it speaks for, its deadline and its batching loaders. */
export interface GqlContext {
  credentials: Credentials;
  loaders: Loaders;
  /** One call under the operation deadline: budget `min(base, time left)`, aborted with the request. */
  call<T>(endpoint: Endpoint<T>, baseBudgetMs: number): Promise<T>;
  settings: BffSettings;
  /** Failed batches already reported on a root path, so one failure is one error per path, not one per id. */
  reported: Set<string>;
  req: Request;
}

/** The standard GraphQL call budgets (FR-031): product 800 ms, shop 500 ms, recommendations and chat as the page. */
export const budgetsFor = (settings: BffSettings) => ({
  product: settings.budgetsMs.product,
  shop: settings.graphql.shopBudgetMs,
  recommendations: settings.budgetsMs.recommendations,
  chat: settings.budgetsMs.chatUnread,
});

/**
 * One set of loaders PER GraphQL REQUEST, created in the Apollo context - not with Nest's REQUEST scope, which would
 * make every provider in the injection chain request-scoped. DataLoader collects all `.load(id)` calls of one tick,
 * de-duplicates them, and issues at most one upstream call per 100 distinct ids; a failed chunk fails only its ids.
 */
export function createGqlContext(args: {
  upstream: UpstreamClient;
  settings: BffSettings;
  credentials: Credentials;
  req: Request;
  signal: AbortSignal;
}): GqlContext {
  const { upstream, settings, credentials, signal } = args;
  const deadlineAt = performance.now() + settings.graphql.deadlineMs;
  const slots = upstream.gate.forRequest();
  const call = async <T>(
    endpoint: Endpoint<T>,
    baseBudgetMs: number,
  ): Promise<T> => {
    const left = deadlineAt - performance.now();
    return (
      await upstream.call(endpoint, {
        credentials,
        slots,
        signal,
        budgetMs: Math.min(baseBudgetMs, left),
        deadlineLimited: left <= baseBudgetMs,
      })
    ).body;
  };
  const batch = settings.graphql.batchSize;
  const budgets = budgetsFor(settings);
  return {
    credentials,
    settings,
    reported: new Set(),
    req: args.req,
    call,
    loaders: {
      product: new DataLoader<string, ProductBatchItem | null>(
        (keys) =>
          loadInChunks(keys, batch, (chunk) =>
            call(productsBatch(chunk), budgets.product),
          ),
        { maxBatchSize: batch },
      ),
      shop: new DataLoader<string, Shop | null>(
        (keys) =>
          loadInChunks(keys, batch, (chunk) =>
            call(shopsBatch(chunk, { shared: false }), budgets.shop),
          ),
        { maxBatchSize: batch },
      ),
    },
  };
}
