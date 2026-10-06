import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, from, map, switchMap, finalize, tap } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import type { VerifiedKey } from '../application/api-keys.service';
import { ApiRequestLogged } from '../application/events/api-events';
import { ApiResourceType, ApiVersion, DEPRECATED_ROUTES, isApiVersion, LATEST_VERSION, transformForVersion } from '../domain/versioning';

const RESOURCE = 'publicApi:resource';
export const ApiResource = (type: ApiResourceType, itemType?: Exclude<ApiResourceType, 'list'>) => SetMetadata(RESOURCE, { type, itemType });

/**
 * Cross-cutting public-API behaviour in one place:
 *  1. version = `Marketplace-Version` header, else the shop's pinned version, else latest;
 *  2. response downgraded to that version's shape (handlers only know the latest);
 *  3. `Deprecation` / `Sunset` / `Link` headers on deprecated routes;
 *  4. `Request-Id` header + an async request-log event (Kafka → ClickHouse) -
 *     never blocking the response.
 */
@Injectable()
export class PublicApiInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly producer: KafkaProducerService,
    private readonly cache: CacheService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { apiKey?: VerifiedKey }>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const started = Date.now();
    const requestId = (req.headers['x-request-id'] as string) || `req_${randomUUID().replace(/-/g, '')}`;
    res.setHeader('Request-Id', requestId);

    const routeKey = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    const deprecation = DEPRECATED_ROUTES[routeKey];
    if (deprecation) {
      res.setHeader('Deprecation', `@${Math.floor(Date.parse(deprecation.deprecatedAt) / 1000)}`);
      res.setHeader('Sunset', new Date(deprecation.sunset).toUTCString());
      res.setHeader('Link', `<${deprecation.replacement}>; rel="successor-version", <https://docs.marketplace.dev/api/deprecations>; rel="deprecation"`);
    }
    const resource = this.reflector.get<{ type: ApiResourceType; itemType?: Exclude<ApiResourceType, 'list'> } | undefined>(RESOURCE, ctx.getHandler());
    let version: ApiVersion = LATEST_VERSION;
    let failedStatus: number | null = null;

    return from(this.resolveVersion(req)).pipe(
      switchMap((resolved) => {
        version = resolved;
        res.setHeader('Marketplace-Version', version);
        return next.handle();
      }),
      map((body) => (resource ? transformForVersion(resource.type, body, version, resource.itemType) : body)),
      // On errors the exception filter writes the status AFTER this pipeline ends - capture it here.
      tap({ error: (error: { status?: number; getStatus?: () => number }) => (failedStatus = error.getStatus?.() ?? error.status ?? 500) }),
      finalize(() => {
        const key = req.apiKey;
        if (!key) return;
        const event = ApiRequestLogged.create(requestId, 0, {
          requestId,
          shopId: key.ownerShopId,
          keyId: key.id,
          livemode: key.livemode,
          version,
          method: req.method,
          route: routeKey.split(' ')[1],
          status: failedStatus ?? res.statusCode,
          durationMs: Date.now() - started,
          deprecated: !!deprecation,
        });
        void this.producer.send({ topic: ApiRequestLogged.topic, key: key.ownerShopId, value: event }).catch(() => undefined);
      }),
    );
  }

  private async resolveVersion(req: Request & { apiKey?: VerifiedKey }): Promise<ApiVersion> {
    const header = req.headers['marketplace-version'] as string | undefined;
    if (header !== undefined) {
      if (!isApiVersion(header)) throw new BadRequestException({ type: 'invalid_version', message: `Unknown version ${header}` });
      return header;
    }
    if (!req.apiKey) return LATEST_VERSION;
    const pinned = await this.cache.getOrLoad<{ v: string }>(
      `api:pinned:${req.apiKey.ownerShopId}`,
      async () => {
        const [row] = await this.sequelize.query<{ pinnedVersion: string }>(`SELECT "pinnedVersion" FROM "ShopApiSettings" WHERE "shopId" = :shopId`, {
          type: QueryTypes.SELECT,
          replacements: { shopId: req.apiKey!.ownerShopId },
        });
        return row ? { v: row.pinnedVersion } : null;
      },
      { ttlMs: 300_000, negativeTtlMs: 300_000, l1: 'always', l1TtlMs: 30_000 },
    );
    return pinned && isApiVersion(pinned.v) ? pinned.v : LATEST_VERSION;
  }
}
