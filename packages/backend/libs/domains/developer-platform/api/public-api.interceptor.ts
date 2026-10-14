import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, map } from 'rxjs';
import { ApiConfigService, PlatformSettings } from '@app/common/config';
import type { VerifiedKey } from '../application/key-verifier.service';
import { apiMetrics } from '../application/metrics';
import {
  ORDER_FIELD_SAMPLE,
  PRODUCT_FIELD_SAMPLE,
} from '../domain/public-views';
import { parseExpand, parseFields, pickFields } from '../domain/sparse-fields';
import {
  ApiResourceType,
  downgradeResponse,
  fieldNamesAt,
  upgradeProductWrite,
} from '../domain/versioning';
import {
  latestVersion,
  type VersionResource,
} from '../domain/version-registry';
import type { ApiRequest } from './request-context.middleware';

const RESOURCE = 'publicApi:resource';

export interface ApiResourceMeta {
  type: ApiResourceType;
  itemType?: VersionResource;
  /** The request body is a product write of an older version: upgrade it before validation. */
  upgrade?: 'productWrite';
}

export const ApiResource = (
  type: ApiResourceType,
  itemType?: VersionResource,
  options: { upgrade?: 'productWrite' } = {},
) =>
  SetMetadata(RESOURCE, {
    type,
    itemType,
    ...options,
  } satisfies ApiResourceMeta);

export type ResourceRequest = ApiRequest & {
  apiKey?: VerifiedKey;
  apiVersion?: string;
  /** `expand` as parsed before the handler ran. */
  apiExpand?: string[];
};

const SAMPLES: Record<VersionResource, Record<string, unknown>> = {
  product: PRODUCT_FIELD_SAMPLE,
  order: ORDER_FIELD_SAMPLE,
};

/**
 * What the version and the query decide about a response, around the handler (FR-026, FR-027, FR-037): the request body
 * of an older version is upgraded to the latest shape before validation, `fields` and `expand` are checked against the
 * requested version's names before any work, and the response is downgraded to the requested version and trimmed.
 * Handlers only know the latest shape.
 */
@Injectable()
export class PublicApiInterceptor implements NestInterceptor {
  private readonly currency: string;

  constructor(
    private readonly reflector: Reflector,
    config: ApiConfigService,
  ) {
    this.currency = new PlatformSettings(config).currency;
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<ResourceRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const meta = this.reflector.get<ApiResourceMeta | undefined>(
      RESOURCE,
      ctx.getHandler(),
    );
    const version = req.apiVersion ?? latestVersion();
    // the limiter answered before this point; no `RateLimit` header on an authenticated call means its store was down
    // and the call was served on the instance's own share (FR-052)
    if (req.apiKey && !res.getHeader('RateLimit'))
      apiMetrics.rateLimitDegraded().add(1);

    if (
      meta?.upgrade === 'productWrite' &&
      version !== latestVersion() &&
      req.body &&
      typeof req.body === 'object'
    )
      req.body = upgradeProductWrite(
        req.body as Record<string, unknown>,
        version,
        {
          currency: this.currency,
        },
      );

    const item =
      meta?.type === 'list'
        ? meta.itemType
        : (meta?.type as VersionResource | undefined);
    const expand =
      meta && item ? parseExpand(this.single(req.query.expand)) : [];
    req.apiExpand = expand;
    const rawFields = meta && item ? this.single(req.query.fields) : undefined;
    const fields = item
      ? parseFields(rawFields, [
          ...fieldNamesAt(item, version, SAMPLES[item]),
          ...(expand.includes('shop') ? ['shop'] : []),
        ])
      : null;

    return next.handle().pipe(
      map((body) => {
        if (!meta) return body;
        const down = downgradeResponse(meta.type, body, version, meta.itemType);
        if (!fields) return down;
        // a trimmed resource still says what it is
        const keep = [
          'id',
          'object',
          ...fields,
          ...(expand.includes('shop') ? ['shop'] : []),
        ];
        if (meta.type === 'list') {
          const l = down as { data: Record<string, unknown>[] };
          return { ...l, data: l.data.map((i) => pickFields(i, keep)) };
        }
        return pickFields(down as Record<string, unknown>, keep);
      }),
    );
  }

  private single(value: Request['query'][string]): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }
}
