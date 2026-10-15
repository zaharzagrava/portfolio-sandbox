import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { WEBHOOK_LIMITS } from '@marketplace-sandbox/contracts';
import { Clock, CLOCK } from '@app/common/core/clock';
import { SecretBox } from '@app/domains/identity';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { transitionEndpoint } from '../domain/endpoint-status';
import { ApiError } from '../domain/errors';
import { parseEndpointUrl } from '../domain/webhook-url';
import {
  AddressGuard,
  BreakerStore,
  EndpointHistory,
  EndpointRecord,
  EndpointRepository,
  HistoryEntry,
  HistoryFacet,
} from '../domain/webhook-ports';
import {
  endpointNotFound,
  endpointStateConflict,
  endpointUrlRejected,
  WebhookError,
} from '../domain/webhook-errors';
import { ApiVersionService } from './api-version.service';
import {
  toEndpointDto,
  type CreateWebhookEndpointRequest,
  type CreatedWebhookEndpoint,
  type RotatedSecret,
  type UpdateWebhookEndpointRequest,
  type WebhookEndpointDto,
  type WebhookEndpointPage,
} from './dto/webhook-endpoint.dto';
import {
  WebhookEndpointChanged,
  type WebhookChange,
} from './events/webhook-events';
import { secretContext } from './webhook-secrets';
import { WebhookSubscriptions } from './webhook-subscriptions.service';

const HOUR_MS = 3_600_000;

/** One state change of an endpoint: its history facet and the event that announces it. */
interface ChangeSpec {
  facet: HistoryFacet;
  from: string | null;
  to: string | null;
  change: WebhookChange;
}

const invalidField = (field: string, code = 'invalid'): ApiError =>
  new ApiError('validation_failed', 'The request is not valid.', {
    errors: [{ field, code }],
  });

/** `whsec_` plus 256 bits as 43 base64url characters (FR-015). */
export const generateWebhookSecret = (): string =>
  `whsec_${randomBytes(32).toString('base64url')}`;

export function encodeEndpointCursor(endpoint: {
  createdAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ c: endpoint.createdAt.toISOString(), i: endpoint.id }),
  ).toString('base64url');
}

export function decodeEndpointCursor(cursor: string): {
  createdAt: Date;
  id: string;
} {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { c?: unknown; i?: unknown };
    const createdAt = new Date(String(parsed.c));
    if (
      typeof parsed.i !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(parsed.i) ||
      Number.isNaN(createdAt.getTime())
    )
      throw new Error('bad cursor');
    return { createdAt, id: parsed.i };
  } catch {
    throw new WebhookError('invalid_cursor', 'The cursor is not valid.');
  }
}

/**
 * Dashboard side of the endpoints (FR-001 to FR-015): validation, the address guard, secrets and the transitions. Every
 * change is one `TransactionRunner.run` that holds the conditional statement, its history rows and its outbox events
 * (FR-011); no network call (the guard's lookup, the breaker store) happens inside it. Limits and uniqueness are the
 * store's (counter row and unique index), never check-then-write. No SQL here: the ports are in `domain/webhook-ports`.
 */
@Injectable()
export class WebhookEndpointsService {
  constructor(
    private readonly endpoints: EndpointRepository,
    private readonly history: EndpointHistory,
    private readonly breaker: BreakerStore,
    private readonly outbox: OutboxService,
    private readonly runner: TransactionRunner,
    private readonly box: SecretBox,
    private readonly versions: ApiVersionService,
    private readonly subscriptions: WebhookSubscriptions,
    private readonly guard: AddressGuard,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------ guards

  /** Syntax first (cheap, no lookup), then the S54 guard: every address the name resolves to must be public. */
  private async checkUrl(
    raw: string,
  ): Promise<{ normalized: string; host: string }> {
    const parsed = parseEndpointUrl(raw);
    if (!parsed.ok) {
      if (parsed.failure.kind === 'rejected')
        throw endpointUrlRejected(parsed.failure.reason);
      throw invalidField('url');
    }
    const verdict = await this.guard.check(raw);
    if (!verdict.ok) throw endpointUrlRejected(verdict.reason);
    return { normalized: parsed.normalized, host: parsed.host };
  }

  /** `latest` and a supported date are accepted; anything else is `400` on `apiVersion`. */
  private resolveVersion(requested: string): string {
    if (requested === 'latest') return this.versions.latestVersion();
    if (!this.versions.isSupported(requested))
      throw invalidField('apiVersion', 'unsupported');
    return requested;
  }

  // ------------------------------------------------------------ plumbing

  private async toDto(endpoint: EndpointRecord): Promise<WebhookEndpointDto> {
    const now = this.clock.now();
    const open = await this.breaker.isOpen(endpoint.id, now.getTime());
    return toEndpointDto(endpoint, {
      breaker: open ? 'open' : 'closed',
      now,
    });
  }

  private change(
    endpoint: Pick<EndpointRecord, 'id' | 'shopId'>,
    change: WebhookChange,
    actorId: string,
    now: Date,
  ) {
    return WebhookEndpointChanged.create(
      endpoint.id,
      0,
      {
        endpointId: endpoint.id,
        shopId: endpoint.shopId,
        change,
        actorId,
      },
      now,
    );
  }

  private entry(
    endpoint: Pick<EndpointRecord, 'id' | 'shopId'>,
    facet: HistoryFacet,
    from: string | null,
    to: string | null,
    actorId: string,
    at: Date,
  ): HistoryEntry {
    return {
      endpointId: endpoint.id,
      shopId: endpoint.shopId,
      facet,
      fromValue: from,
      toValue: to,
      actorId,
      at,
    };
  }

  /** Writes the history rows and the outbox events of one change, in the transaction that is open. */
  private async record(
    endpoint: Pick<EndpointRecord, 'id' | 'shopId'>,
    changes: ChangeSpec[],
    actorId: string,
    now: Date,
  ): Promise<void> {
    await this.history.append(
      changes.map((c) =>
        this.entry(endpoint, c.facet, c.from, c.to, actorId, now),
      ),
    );
    await this.outbox.append(
      changes.map((c) => this.change(endpoint, c.change, actorId, now)),
    );
  }

  // ------------------------------------------------------------ create, read, list

  async create(
    shopId: string,
    actorId: string,
    input: CreateWebhookEndpointRequest,
  ): Promise<CreatedWebhookEndpoint> {
    const requested = input.apiVersion
      ? this.resolveVersion(input.apiVersion)
      : undefined;
    const url = await this.checkUrl(input.url);
    const apiVersion =
      requested ??
      (await this.versions.getPinnedVersions([shopId])).get(shopId)!;
    const id = uuidv7();
    const secret = generateWebhookSecret();
    const now = this.clock.now();
    const outcome = await this.runner.run(async () => {
      const inserted = await this.endpoints.insertWithinLimit(
        {
          id,
          shopId,
          url: input.url,
          urlNormalized: url.normalized,
          events: input.events,
          apiVersion,
          secretSealed: this.box.seal(secret, secretContext(id)),
          now,
        },
        WEBHOOK_LIMITS.endpointsPerShop,
      );
      if (inserted.outcome === 'created')
        await this.record(
          inserted.endpoint,
          [{ facet: 'created', from: null, to: url.host, change: 'created' }],
          actorId,
          now,
        );
      return inserted;
    });
    if (outcome.outcome === 'duplicate_url')
      throw new WebhookError(
        'duplicate_endpoint_url',
        'This shop already has an endpoint at this address.',
      );
    if (outcome.outcome === 'limit_reached')
      throw new WebhookError(
        'endpoint_limit_reached',
        `A shop can have at most ${WEBHOOK_LIMITS.endpointsPerShop} webhook endpoints.`,
      );
    await this.subscriptions.invalidate(shopId, id);
    const endpoint = outcome.endpoint;
    return {
      id,
      url: endpoint.url,
      events: endpoint.events,
      apiVersion: endpoint.apiVersion,
      status: 'enabled',
      secret,
      createdAt: endpoint.createdAt.toISOString(),
    };
  }

  private async require(shopId: string, id: string): Promise<EndpointRecord> {
    const endpoint = await this.endpoints.findById(shopId, id);
    if (!endpoint) throw endpointNotFound();
    return endpoint;
  }

  async get(shopId: string, id: string): Promise<WebhookEndpointDto> {
    return this.toDto(await this.require(shopId, id));
  }

  async list(
    shopId: string,
    query: { limit: number; cursor?: string },
  ): Promise<WebhookEndpointPage> {
    const after = query.cursor ? decodeEndpointCursor(query.cursor) : undefined;
    const rows = await this.endpoints.listPage(shopId, {
      limit: query.limit,
      after,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: await Promise.all(page.map((e) => this.toDto(e))),
      nextCursor:
        rows.length > query.limit
          ? encodeEndpointCursor(page[page.length - 1])
          : null,
    };
  }

  // ------------------------------------------------------------ update

  async update(
    shopId: string,
    id: string,
    actorId: string,
    patch: UpdateWebhookEndpointRequest,
  ): Promise<WebhookEndpointDto> {
    const apiVersion = patch.apiVersion
      ? this.resolveVersion(patch.apiVersion)
      : undefined;
    const url = patch.url ? await this.checkUrl(patch.url) : undefined;
    const now = this.clock.now();
    const result = await this.runner.run(async () => {
      const updated = await this.endpoints.update(
        shopId,
        id,
        {
          url: patch.url,
          urlNormalized: url?.normalized,
          events: patch.events,
          apiVersion,
        },
        now,
      );
      if (updated.outcome !== 'applied') return updated;
      const { before, endpoint } = updated;
      const changes: ChangeSpec[] = [];
      if (endpoint.url !== before.url)
        changes.push({
          facet: 'url',
          from: new URL(before.url).host,
          to: new URL(endpoint.url).host,
          change: 'url_changed',
        });
      if (endpoint.events.join(',') !== before.events.join(','))
        changes.push({
          facet: 'events',
          from: before.events.join(','),
          to: endpoint.events.join(','),
          change: 'events_changed',
        });
      if (endpoint.apiVersion !== before.apiVersion)
        changes.push({
          facet: 'api_version',
          from: before.apiVersion,
          to: endpoint.apiVersion,
          change: 'api_version_changed',
        });
      await this.record(endpoint, changes, actorId, now);
      return updated;
    });
    if (result.outcome === 'not_found') throw endpointNotFound();
    if (result.outcome === 'duplicate_url')
      throw new WebhookError(
        'duplicate_endpoint_url',
        'This shop already has an endpoint at this address.',
      );
    await this.subscriptions.invalidate(shopId, id);
    return this.toDto(result.endpoint);
  }

  // ------------------------------------------------------------ enable, disable, delete

  async disable(
    shopId: string,
    id: string,
    actorId: string,
  ): Promise<WebhookEndpointDto> {
    return this.transition(shopId, id, actorId, 'disable');
  }

  async enable(
    shopId: string,
    id: string,
    actorId: string,
  ): Promise<WebhookEndpointDto> {
    return this.transition(shopId, id, actorId, 'enable');
  }

  private async transition(
    shopId: string,
    id: string,
    actorId: string,
    action: 'enable' | 'disable',
  ): Promise<WebhookEndpointDto> {
    const current = await this.require(shopId, id);
    const target = transitionEndpoint(
      current.status,
      action === 'enable'
        ? { type: 'enable' }
        : { type: 'disable', reason: 'manual' },
    );
    if (!target.ok) throw endpointStateConflict(target.from);
    // An address that became blocked since it was saved must not come back to life (FR-003).
    if (action === 'enable') await this.checkUrl(current.url);
    const now = this.clock.now();
    const result = await this.runner.run(async () => {
      const done = await this.endpoints.transition(
        shopId,
        id,
        current.status,
        { status: target.status, disabledReason: target.disabledReason },
        now,
      );
      if (done.outcome === 'applied')
        await this.record(
          done.endpoint,
          [
            {
              facet: 'status',
              from: current.status,
              to: target.status,
              change: action === 'enable' ? 'enabled' : 'disabled',
            },
          ],
          actorId,
          now,
        );
      return done;
    });
    if (result.outcome === 'not_found') throw endpointNotFound();
    if (result.outcome === 'conflict')
      throw endpointStateConflict(result.current.status);
    if (action === 'enable') await this.breaker.reset(id);
    await this.subscriptions.invalidate(shopId, id);
    return this.toDto(result.endpoint);
  }

  async remove(shopId: string, id: string, actorId: string): Promise<void> {
    const now = this.clock.now();
    const removed = await this.runner.run(async () => {
      const deleted = await this.endpoints.delete(shopId, id);
      if (deleted)
        await this.record(
          deleted,
          [{ facet: 'deleted', from: null, to: null, change: 'deleted' }],
          actorId,
          now,
        );
      return deleted;
    });
    if (!removed) throw endpointNotFound();
    await this.breaker.reset(id);
    await this.subscriptions.invalidate(shopId, id);
  }

  // ------------------------------------------------------------ secrets

  /** A new secret; the old one keeps signing until the overlap ends. Refused while a previous secret is still valid. */
  async rotateSecret(
    shopId: string,
    id: string,
    actorId: string,
    overlapHours: number = WEBHOOK_LIMITS.overlapHours.default,
  ): Promise<RotatedSecret> {
    const secret = generateWebhookSecret();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + overlapHours * HOUR_MS);
    const result = await this.runner.run(async () => {
      const done = await this.endpoints.rotateSecret(
        shopId,
        id,
        {
          secretSealed: this.box.seal(secret, secretContext(id)),
          previousExpiresAt: expiresAt,
        },
        now,
      );
      if (done.outcome === 'applied')
        await this.record(
          done.endpoint,
          [
            {
              facet: 'secret_rotated',
              from: null,
              to: null,
              change: 'secret_rotated',
            },
          ],
          actorId,
          now,
        );
      return done;
    });
    if (result.outcome === 'not_found') throw endpointNotFound();
    if (result.outcome === 'conflict')
      throw new WebhookError(
        'rotation_in_progress',
        'The previous secret is still valid; expire it or wait.',
      );
    await this.subscriptions.invalidate(shopId, id);
    return { secret, previousSecretExpiresAt: expiresAt.toISOString() };
  }

  async expirePreviousSecret(
    shopId: string,
    id: string,
    actorId: string,
  ): Promise<WebhookEndpointDto> {
    const now = this.clock.now();
    const result = await this.runner.run(async () => {
      const done = await this.endpoints.expirePreviousSecret(shopId, id, now);
      if (done.outcome === 'applied')
        await this.record(
          done.endpoint,
          [
            {
              facet: 'previous_secret_expired',
              from: null,
              to: null,
              change: 'previous_secret_expired',
            },
          ],
          actorId,
          now,
        );
      return done;
    });
    if (result.outcome === 'not_found') throw endpointNotFound();
    if (result.outcome === 'conflict')
      throw new WebhookError(
        'no_previous_secret',
        'There is no previous secret.',
      );
    await this.subscriptions.invalidate(shopId, id);
    return this.toDto(result.endpoint);
  }
}
