import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { randomBytes } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { SecretBox } from '@app/domains/identity';
import { Environment } from '@app/common/types';
import { checkSafeUrl, SafeRequestError } from '@app/infrastructure/net';
import { LATEST_VERSION, isApiVersion } from '../domain/versioning';
import {
  WEBHOOK_EVENT_TYPES,
  WebhookEventType,
} from '../domain/webhook-events';

export interface EndpointRecord {
  id: string;
  shopId: string;
  url: string;
  events: WebhookEventType[];
  apiVersion: string;
  enabled: boolean;
  failingSince: string | null;
  secrets: string[];
}

const endpointKey = (id: string) => `wh:endpoint:${id}`;
const shopEndpointsKey = (shopId: string) => `wh:shop:${shopId}`;

@Injectable()
export class WebhookEndpointsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly cache: CacheService,
    private readonly box: SecretBox,
    private readonly config: ApiConfigService,
  ) {}

  /** Local/test only: lets specs point endpoints at a server on 127.0.0.1. */
  get ssrfOptions() {
    if (this.config.get('node_env') === Environment.production) return {};
    const hosts = (this.config.get('webhooks_allow_private_hosts') ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    return { allowHttpHosts: hosts, allowPrivateHosts: hosts };
  }

  async create(
    shopId: string,
    input: { url: string; events: WebhookEventType[]; apiVersion?: string },
  ) {
    await this.validateUrl(input.url);
    if (input.apiVersion && !isApiVersion(input.apiVersion))
      throw new BadRequestException('Unknown API version');
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const [row] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "WebhookEndpoint" ("shopId", url, events, "apiVersion", "secretSealed") VALUES (:shopId, :url, CAST(:events AS text[]), :apiVersion, :sealed) RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId,
          url: input.url,
          events: `{${input.events.join(',')}}`,
          apiVersion: input.apiVersion ?? LATEST_VERSION,
          sealed: this.box.seal(secret),
        },
      },
    );
    await this.cache.invalidate([shopEndpointsKey(shopId)]);
    // Shown once; afterwards only the sealed copy exists.
    return { id: row.id, url: input.url, events: input.events, secret };
  }

  list(shopId: string) {
    return this.sequelize.query(
      `SELECT id, url, events, "apiVersion", enabled, "disabledReason", "failingSince", "createdAt" FROM "WebhookEndpoint" WHERE "shopId" = :shopId ORDER BY "createdAt"`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
  }

  async update(
    shopId: string,
    id: string,
    patch: { events?: WebhookEventType[]; enabled?: boolean; url?: string },
  ) {
    if (patch.url) await this.validateUrl(patch.url);
    const [, meta] = await this.sequelize.query(
      `UPDATE "WebhookEndpoint" SET events = coalesce(CAST(:events AS text[]), events), url = coalesce(:url, url),
              enabled = coalesce(:enabled, enabled),
              "disabledReason" = CASE WHEN :enabled THEN NULL ELSE "disabledReason" END,
              "failingSince" = CASE WHEN :enabled THEN NULL ELSE "failingSince" END, "updatedAt" = now()
       WHERE id = :id AND "shopId" = :shopId`,
      {
        replacements: {
          id,
          shopId,
          events: patch.events ? `{${patch.events.join(',')}}` : null,
          url: patch.url ?? null,
          enabled: patch.enabled ?? null,
        },
      },
    );
    if (!(meta as { rowCount?: number }).rowCount)
      throw new NotFoundException('Endpoint not found');
    await this.cache.invalidate([endpointKey(id), shopEndpointsKey(shopId)]);
  }

  /** New secret; the old one keeps signing (second v1=) for 24 h so receivers can deploy the new one. */
  async rotateSecret(shopId: string, id: string) {
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const [, meta] = await this.sequelize.query(
      `UPDATE "WebhookEndpoint" SET "previousSecretSealed" = "secretSealed", "previousSecretExpiresAt" = now() + interval '24 hours', "secretSealed" = :sealed, "updatedAt" = now()
       WHERE id = :id AND "shopId" = :shopId`,
      { replacements: { id, shopId, sealed: this.box.seal(secret) } },
    );
    if (!(meta as { rowCount?: number }).rowCount)
      throw new NotFoundException('Endpoint not found');
    await this.cache.invalidate([endpointKey(id)]);
    return { secret };
  }

  async remove(shopId: string, id: string) {
    await this.sequelize.query(
      `DELETE FROM "WebhookEndpoint" WHERE id = :id AND "shopId" = :shopId`,
      { replacements: { id, shopId } },
    );
    await this.cache.invalidate([endpointKey(id), shopEndpointsKey(shopId)]);
  }

  /** Router hot path: a shop's enabled endpoints, cached (events change rarely; edits invalidate). */
  async subscribers(
    shopId: string,
    type: WebhookEventType,
  ): Promise<{ id: string; apiVersion: string }[]> {
    const all =
      (await this.cache.getOrLoad<
        { id: string; events: string[]; apiVersion: string }[]
      >(
        shopEndpointsKey(shopId),
        () =>
          this.sequelize.query(
            `SELECT id, events, "apiVersion" FROM "WebhookEndpoint" WHERE "shopId" = :shopId AND enabled`,
            {
              type: QueryTypes.SELECT,
              replacements: { shopId },
            },
          ),
        { ttlMs: 60_000, l1: 'hot' },
      )) ?? [];
    return all.filter((e) => e.events.includes(type));
  }

  /** Delivery hot path (secrets decrypted per use, never cached in plaintext). */
  async get(id: string): Promise<EndpointRecord | null> {
    const row = await this.cache.getOrLoad<
      EndpointRecord & {
        secretSealed: string;
        previousSecretSealed: string | null;
        previousSecretExpiresAt: string | null;
      }
    >(
      endpointKey(id),
      async () =>
        (
          await this.sequelize.query<
            EndpointRecord & {
              secretSealed: string;
              previousSecretSealed: string | null;
              previousSecretExpiresAt: string | null;
            }
          >(
            `SELECT id, "shopId", url, events, "apiVersion", enabled, "failingSince", "secretSealed", "previousSecretSealed", "previousSecretExpiresAt" FROM "WebhookEndpoint" WHERE id = :id`,
            { type: QueryTypes.SELECT, replacements: { id } },
          )
        )[0] ?? null,
      { ttlMs: 30_000, negativeTtlMs: 30_000, l1: 'never' },
    );
    if (!row) return null;
    const secrets = [this.box.open(row.secretSealed)];
    if (
      row.previousSecretSealed &&
      row.previousSecretExpiresAt &&
      Date.parse(row.previousSecretExpiresAt) > Date.now()
    )
      secrets.push(this.box.open(row.previousSecretSealed));
    const {
      secretSealed: _a,
      previousSecretSealed: _b,
      previousSecretExpiresAt: _c,
      ...rest
    } = row;
    return { ...rest, secrets };
  }

  async markHealthy(id: string) {
    const [, meta] = await this.sequelize.query(
      `UPDATE "WebhookEndpoint" SET "failingSince" = NULL WHERE id = :id AND "failingSince" IS NOT NULL`,
      { replacements: { id } },
    );
    if ((meta as { rowCount?: number }).rowCount)
      await this.cache.invalidate([endpointKey(id)]);
  }

  async markFailing(id: string): Promise<Date> {
    const [row] = await this.sequelize.query<{ failingSince: Date }>(
      `UPDATE "WebhookEndpoint" SET "failingSince" = coalesce("failingSince", now()) WHERE id = :id RETURNING "failingSince"`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    await this.cache.invalidate([endpointKey(id)]);
    return new Date(row.failingSince);
  }

  async disable(
    id: string,
    reason: string,
  ): Promise<{ shopId: string; url: string } | null> {
    const [row] = await this.sequelize.query<{ shopId: string; url: string }>(
      `UPDATE "WebhookEndpoint" SET enabled = false, "disabledReason" = :reason, "updatedAt" = now() WHERE id = :id AND enabled RETURNING "shopId", url`,
      { type: QueryTypes.SELECT, replacements: { id, reason } },
    );
    if (row)
      await this.cache.invalidate([
        endpointKey(id),
        shopEndpointsKey(row.shopId),
      ]);
    return row ?? null;
  }

  private async validateUrl(url: string) {
    try {
      await checkSafeUrl(url, this.ssrfOptions);
    } catch (error) {
      if (error instanceof SafeRequestError)
        throw new BadRequestException(
          `Endpoint URL rejected: ${error.message}`,
        );
      throw error;
    }
  }
}
