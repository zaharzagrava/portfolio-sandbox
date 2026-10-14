import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService, PlatformSettings } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  AppError,
  Fatal_InternalServerError,
} from '@app/common/errors/error.types';
import { buildProblemDocument } from '@app/common/exceptions-filter/problem-document';
import {
  IdempotencyRepository,
  requestFingerprint,
} from '@app/infrastructure/idempotency';
import type { ApiScope } from '../domain/api-key-format';
import { OperationValidator } from '../domain/ports';
import { IDEMPOTENCY_KEY_PATTERN, parseIfMatch } from '../domain/request-rules';
import {
  BatchOperation,
  deadlineExceeded,
  planBatch,
} from '../domain/batch-plan';
import { ApiError, insufficientScope } from '../domain/errors';
import { downgradeResponse, upgradeProductWrite } from '../domain/versioning';
import { latestVersion } from '../domain/version-registry';
import type { ApiContext } from './api-context';
import { apiMetrics } from './metrics';
import { PublicCatalogService } from './public-catalog.service';

export interface BatchOperationResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const DAY_MS = 86_400_000;
const LOCK_MS = 60_000;
const UUID_PATH = '([^/]+)';

/**
 * `POST /v1/batch` (FR-043…FR-045): the operations run in order, each by the rules of its own route (scope, tenant, schema,
 * version, idempotency) and each reporting its own `{status, body}`; a failure is that operation's result, never the
 * batch's, and the batch is never one transaction. A 10 s budget on the injected clock: operations not started in time
 * answer `503 batch_deadline_exceeded` and do not run. A running operation is never interrupted.
 */
@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);
  private readonly currency: string;

  constructor(
    private readonly catalog: PublicCatalogService,
    private readonly idempotency: IdempotencyRepository,
    private readonly validator: OperationValidator,
    config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.currency = new PlatformSettings(config).currency;
  }

  async run(
    ctx: ApiContext,
    version: string,
    operations: BatchOperation[],
  ): Promise<{ object: 'batch'; results: BatchOperationResult[] }> {
    const plan = planBatch(operations);
    const started = this.clock.now().getTime();
    const results: BatchOperationResult[] = [];
    for (const { operation, batchable } of plan) {
      if (deadlineExceeded(started, this.clock.now().getTime())) {
        apiMetrics.batchDeadlineExceeded().add(1);
        results.push(
          this.problem(
            new ApiError(
              'batch_deadline_exceeded',
              'The batch ran out of time before this operation started.',
              {
                retryable: true,
              },
            ),
          ),
        );
        continue;
      }
      results.push(
        batchable
          ? await this.runOne(ctx, version, operation)
          : this.problem(
              new ApiError(
                'unsupported_operation',
                `${operation.method} ${operation.path} cannot be part of a batch.`,
              ),
            ),
      );
    }
    return { object: 'batch', results };
  }

  private async runOne(
    ctx: ApiContext,
    version: string,
    op: BatchOperation,
  ): Promise<BatchOperationResult> {
    try {
      const path = op.path.split('?')[0];
      if (op.method === 'GET' && path === '/v1/products') {
        this.need(ctx, 'products:read');
        return this.ok(
          200,
          downgradeResponse(
            'list',
            await this.catalog.list(ctx, {}, []),
            version,
            'product',
          ),
        );
      }
      const product = new RegExp(`^/v1/products/${UUID_PATH}$`).exec(path);
      if (op.method === 'GET' && product) {
        this.need(ctx, 'products:read');
        return this.ok(
          200,
          downgradeResponse(
            'product',
            await this.catalog.get(ctx, product[1], []),
            version,
          ),
        );
      }
      const stock = new RegExp(`^/v1/stock/${UUID_PATH}$`).exec(path);
      if (op.method === 'GET' && stock) {
        this.need(ctx, 'products:read');
        return this.ok(200, await this.catalog.stock(ctx, stock[1]));
      }
      if (op.method === 'PATCH' && product) {
        this.need(ctx, 'products:write');
        const expected = parseIfMatch(op.ifMatch);
        const body = await this.validator.updateProduct(
          this.upgrade(op.body, version),
        );
        if (Object.keys(body).length === 0)
          throw new ApiError(
            'validation_failed',
            'At least one field to change is required.',
            {
              errors: [{ field: 'body', code: 'empty' }],
            },
          );
        const updated = await this.catalog.update(
          ctx,
          product[1],
          body,
          expected,
        );
        return this.ok(200, downgradeResponse('product', updated, version));
      }
      if (op.method === 'POST' && path === '/v1/products') {
        this.need(ctx, 'products:write');
        return await this.createOnce(ctx, version, op);
      }
      throw new ApiError(
        'unsupported_operation',
        `${op.method} ${op.path} cannot be part of a batch.`,
      );
    } catch (error) {
      return this.problem(error);
    }
  }

  /** `POST` operations need their own key; the key's scope is the acting shop and the operation's route (FR-049). */
  private async createOnce(
    ctx: ApiContext,
    version: string,
    op: BatchOperation,
  ): Promise<BatchOperationResult> {
    const key = op.idempotencyKey;
    if (key === undefined)
      throw new ApiError(
        'idempotency_key_required',
        'A POST operation needs an idempotencyKey.',
      );
    if (!IDEMPOTENCY_KEY_PATTERN.test(key))
      throw new ApiError(
        'validation_failed',
        'idempotencyKey must be 1 to 255 printable characters.',
        {
          errors: [{ field: 'idempotencyKey', code: 'invalid' }],
        },
      );
    const scope = `shop:${ctx.shopId}:batch-op:POST /v1/products`;
    const fingerprint = requestFingerprint({
      method: 'POST',
      path: op.path,
      rawQuery: '',
      body: op.body,
    });
    const claim = await this.idempotency.claim({
      scope,
      key,
      fingerprint,
      now: this.clock.now(),
      ttlMs: DAY_MS,
      lockMs: LOCK_MS,
    });
    if (!claim.claimed) {
      const existing = claim.existing;
      if (existing.fingerprint.trim() !== fingerprint)
        throw new ApiError(
          'idempotency_key_reused',
          'This idempotencyKey was used with a different operation.',
        );
      if (
        existing.state === 'in_flight' ||
        !existing.bodyStored ||
        !existing.responseBody
      )
        throw new ApiError(
          'request_in_progress',
          'An operation with this idempotencyKey is still running.',
          {
            retryAfterSeconds: 1,
          },
        );
      return {
        status: existing.responseStatus ?? 200,
        body: JSON.parse(existing.responseBody.toString('utf8')),
        headers: { 'Idempotent-Replayed': 'true' },
      };
    }
    let result: BatchOperationResult;
    try {
      const body = await this.validator.createProduct(
        this.upgrade(op.body, version),
      );
      const created = await this.catalog.create(ctx, body);
      result = this.ok(201, downgradeResponse('product', created, version));
    } catch (error) {
      result = this.problem(error);
    }
    // a 5xx is never stored: the key is released so a retry runs again; everything else is replayed
    if (result.status >= 500) {
      await this.idempotency
        .release(scope, key, claim.token)
        .catch(() => undefined);
      return result;
    }
    await this.idempotency
      .complete({
        scope,
        key,
        token: claim.token,
        status: result.status,
        headers: null,
        body: Buffer.from(JSON.stringify(result.body), 'utf8'),
        bodyStored: true,
      })
      .catch((error: Error) =>
        this.logger.error(
          `batch operation answer not stored: ${error.message}`,
        ),
      );
    return result;
  }

  private need(ctx: ApiContext, scope: ApiScope): void {
    if (!ctx.scopes.includes(scope)) throw insufficientScope([scope]);
  }

  private upgrade(body: unknown, version: string): Record<string, unknown> {
    const plain = (body ?? {}) as Record<string, unknown>;
    return version === latestVersion()
      ? plain
      : upgradeProductWrite(plain, version, { currency: this.currency });
  }

  private ok(status: number, body: unknown): BatchOperationResult {
    return { status, body };
  }

  /** A failed operation is a problem body without internals; anything unexpected is a generic `500`. */
  private problem(error: unknown): BatchOperationResult {
    const known = error instanceof AppError ? error : undefined;
    if (!known)
      this.logger.error(`batch operation failed: ${(error as Error)?.message}`);
    const doc = buildProblemDocument(known ?? new Fatal_InternalServerError(), {
      requestId: 'batch',
      instance: '/v1/batch',
    });
    const { requestId: _drop, ...body } = doc.body;
    return { status: doc.status, body };
  }
}
