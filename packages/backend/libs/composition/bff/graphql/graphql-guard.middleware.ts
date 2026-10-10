import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { parse } from 'graphql';
import {
  BFF_COOKIES,
  persistedQueryExtensionSchema,
} from '@marketplace-sandbox/contracts';
import {
  Domain_RateLimitCostExceededError,
  Domain_RateLimitedError,
  formatRetryAfter,
  headersFor,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import { BffSettings } from '../bff-config';
import {
  readCookie,
  RequestCredentials,
  type RequestWithCredentials,
} from '../credentials/request-credentials';
import { BffProblem } from '../problem';
import '../rate-limit-policies';
import { RequestGuards } from '../session/csrf-origin.guard';
import { checkArguments } from './inputs';
import { analyzeQuery } from './limits';
import { sha256Hex, TrustedDocuments } from './trusted-documents';

type GqlRequest = RequestWithCredentials & {
  body?: {
    query?: unknown;
    variables?: unknown;
    operationName?: unknown;
    extensions?: Record<string, unknown>;
  };
  clientIp?: string;
};

const POLICY = 'bff.graphql.cost' as const;
const COST_POLICY = { limit: 20_000, windowMs: 60_000 };

/**
 * Everything that must happen before Apollo sees a request (S48 plan: "GraphQL limits order"), so a refusal costs zero
 * upstream calls: media type, array batching and document size (HTTP problems) → ambiguity and CSRF → credentials →
 * trusted documents (hash lookup, mismatch, `GET` rules) → limits (depth, cost, root fields, input bounds; refused
 * queries are charged one unit) → the cost charge on the principal's budget. Fragment cycles, mutations and
 * subscriptions are refused here too. Only then does the document reach the executor.
 */
@Injectable()
export class GraphqlGuardMiddleware implements NestMiddleware {
  constructor(
    private readonly settings: BffSettings,
    private readonly guards: RequestGuards,
    private readonly credentials: RequestCredentials,
    private readonly documents: TrustedDocuments,
    private readonly limiter: RateLimiterService,
  ) {}

  async use(req: GqlRequest, res: Response, next: NextFunction): Promise<void> {
    if (!(await this.handle(req, res))) next();
  }

  /** `true` when the middleware already answered. */
  private async handle(req: GqlRequest, res: Response): Promise<boolean> {
    const isPost = req.method === 'POST';
    const isGet = req.method === 'GET';
    if (!isPost && !isGet) return false;
    res.setHeader('Vary', 'Authorization, Cookie, X-Anonymous-Id');

    let operation: GqlOperation;
    if (isPost) {
      if (!req.is('application/json'))
        throw new BffProblem('unsupported_media_type');
      if (Array.isArray(req.body))
        throw new BffProblem('batching_not_supported');
      operation = {
        query: typeof req.body?.query === 'string' ? req.body.query : undefined,
        variables: asRecord(req.body?.variables),
        operationName:
          typeof req.body?.operationName === 'string'
            ? req.body.operationName
            : undefined,
        extensions: req.body?.extensions,
      };
      if (
        operation.query !== undefined &&
        Buffer.byteLength(operation.query) >
          this.settings.graphql.maxDocumentBytes
      )
        throw new BffProblem('payload_too_large');
    } else {
      const q = (req.query ?? {}) as Record<string, unknown>;
      operation = {
        query: typeof q.query === 'string' ? q.query : undefined,
        variables: parseJson(q.variables),
        operationName:
          typeof q.operationName === 'string' ? q.operationName : undefined,
        extensions: parseJson(q.extensions),
      };
      // a GET may only name a registered document: raw text and non-queries are refused (FR-036)
      if (operation.query !== undefined)
        throw new BffProblem('persisted_query_required');
    }

    this.guards.assertNotAmbiguous(req);
    if (isPost && readCookie(req, BFF_COOKIES.session))
      this.guards.assertCsrf(req);

    req.credentials = await this.credentials.resolve(req, res);
    const subject = req.user?.id
      ? `user:${req.user.id}`
      : (req.clientIp ?? req.ip ?? 'unknown');

    // ---- trusted documents -------------------------------------------------------------------------------------
    const hash = this.hashOf(operation);
    let text = operation.query;
    if (hash !== undefined) {
      if (text !== undefined && sha256Hex(text) !== hash)
        throw new BffProblem('persisted_query_mismatch');
      const registered = this.documents.get(hash);
      if (registered !== undefined) text = registered;
      else if (this.settings.trustedDocuments || text === undefined) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({
          errors: [
            {
              message: 'PersistedQueryNotFound',
              extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' },
            },
          ],
        });
        return true;
      }
    } else if (text !== undefined && this.settings.trustedDocuments) {
      throw new BffProblem('persisted_query_required');
    }
    if (isGet && text === undefined)
      throw new BffProblem('persisted_query_required');
    if (text === undefined) return false; // Apollo explains what is missing

    // ---- limits --------------------------------------------------------------------------------------------------
    let document;
    try {
      document = parse(text);
    } catch {
      return false; // a syntax error is Apollo's 400; it makes no upstream call
    }
    const limits = {
      maxDepth: this.settings.graphql.maxDepth,
      maxCost: this.settings.graphql.maxCost,
      maxRootFields: this.settings.graphql.maxRootFields,
      maxIds: this.settings.graphql.maxIds,
    };
    const verdict = analyzeQuery(
      document,
      operation.variables,
      operation.operationName,
      limits,
    );
    const input = verdict.ok
      ? checkArguments(
          document,
          operation.variables,
          this.settings.graphql.maxIds,
        )
      : undefined;
    if (!verdict.ok || input) {
      await this.charge(res, subject, 1);
      res.setHeader('Cache-Control', 'no-store');
      res.status(400).json({
        errors: [
          verdict.ok
            ? {
                message: input!.message,
                extensions: { code: 'BAD_USER_INPUT' },
              }
            : { message: verdict.message, extensions: { code: verdict.code } },
        ],
      });
      return true;
    }

    // ---- cost budget ---------------------------------------------------------------------------------------------
    await this.charge(res, subject, Math.max(1, Math.ceil(verdict.cost)));

    // ---- hand over -----------------------------------------------------------------------------------------------
    if (isPost) {
      req.body = { ...req.body, query: text };
      const rest = { ...(operation.extensions ?? {}) };
      delete rest.persistedQuery;
      if (Object.keys(rest).length > 0) req.body!.extensions = rest;
      else delete req.body!.extensions;
    } else {
      const url = new URL(req.url, 'http://local');
      url.searchParams.set('query', text);
      url.searchParams.delete('extensions');
      req.url = `${url.pathname}${url.search}`;
    }
    return false;
  }

  private hashOf(operation: GqlOperation): string | undefined {
    const ext = operation.extensions;
    if (ext === undefined || ext === null) return undefined;
    const parsed = persistedQueryExtensionSchema.safeParse(ext);
    if (!parsed.success) {
      if ((ext as Record<string, unknown>).persistedQuery !== undefined)
        throw new BffProblem('persisted_query_mismatch');
      return undefined;
    }
    return parsed.data.persistedQuery.sha256Hash;
  }

  /** Charges the principal's cost budget; a denial is a 429 problem with the structured rate-limit headers. */
  private async charge(
    res: Response,
    subject: string,
    cost: number,
  ): Promise<void> {
    const decision = await this.limiter.check(POLICY, subject, cost);
    const trusted =
      decision.source !== 'fallback' && decision.reason !== 'store-unavailable';
    const headers = trusted
      ? headersFor([
          {
            name: POLICY,
            limit: COST_POLICY.limit,
            windowMs: COST_POLICY.windowMs,
            remaining: decision.remaining,
            resetMs: decision.allowed
              ? decision.resetMs
              : (decision.retryAfterMs ?? 0),
          },
        ])
      : {};
    if (!decision.allowed) {
      if (decision.reason === 'cost-exceeds-limit')
        throw new Domain_RateLimitCostExceededError(headers);
      throw new Domain_RateLimitedError(
        Number(formatRetryAfter(decision.retryAfterMs ?? 1_000)),
        {
          ...headers,
          'Cache-Control': 'no-store',
        },
      );
    }
    for (const [name, value] of Object.entries(headers))
      res.setHeader(name, value);
  }
}

interface GqlOperation {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  extensions?: Record<string, unknown>;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const parseJson = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v !== 'string') return undefined;
  try {
    return asRecord(JSON.parse(v));
  } catch {
    throw new BffProblem('validation_failed');
  }
};
