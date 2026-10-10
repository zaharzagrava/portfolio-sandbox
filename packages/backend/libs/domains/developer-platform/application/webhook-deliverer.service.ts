import { Injectable, Logger } from '@nestjs/common';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { NotificationRouter } from '@app/domains/notifications';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { SafeRequestError } from '@app/infrastructure/net';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { postWebhook, SendResult } from '../infra/http-sender';
import { signWebhook, SIGNATURE_HEADER } from '../domain/signature';
import { WebhookDelivery, WEBHOOK_EVENT_TYPES } from '../domain/webhook-events';
import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'webhooks.retry': WebhookDelivery;
  }
}

declareJobType({
  name: 'webhooks.retry',
  contract: z.object({
    endpointId: z.string(),
    eventId: z.string(),
    type: z.enum(WEBHOOK_EVENT_TYPES),
    body: z.string(),
    attempt: z.number(),
  }),
});

/** Immediate retries inside the FIFO (ordering kept), then the long-backoff lane. */
const FIFO_RECEIVES = 3;
/** Backoff lane delays: ~3 days total, then the endpoint is disabled. */
export const RETRY_SCHEDULE_MIN = [5, 30, 120, 300, 600, 1_440, 1_440, 1_440];
const DISABLE_AFTER_MS = 3 * 86_400_000;
const BREAKER_THRESHOLD = 5;
const BREAKER_BASE_MS = 60_000;
const BREAKER_MAX_MS = 30 * 60_000;
const LOG_TTL_DAYS = 30;

export type DeliveryOutcome =
  | 'delivered'
  | 'retry-fifo'
  | 'retry-later'
  | 'skipped'
  | 'blocked'
  | 'disabled';

/**
 * One delivery attempt (shared by the SQS worker and the Lambda handler):
 *   endpoint enabled? → circuit open? → SSRF re-check (DNS can change between
 *   creation and delivery) → sign → POST pinned to the checked IP → log →
 *   success resets health; failure feeds the breaker, the retry policy and,
 *   after 3 days, auto-disable + an email to the shop.
 */
@Injectable()
export class WebhookDeliverer {
  private readonly logger = new Logger(WebhookDeliverer.name);

  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly redis: RedisService,
    private readonly dynamo: DynamoService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationRouter,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  async deliver(
    msg: WebhookDelivery,
    receiveCount = 1,
  ): Promise<DeliveryOutcome> {
    const endpoint = await this.endpoints.get(msg.endpointId);
    if (!endpoint || !endpoint.enabled) return 'skipped';
    await this.storeBody(msg);

    const openUntil = Number(
      (await this.redis.client.get(breakerKey(msg.endpointId))) ?? 0,
    );
    if (openUntil > Date.now()) {
      // Don't burn a 10 s timeout per message on an endpoint we know is down.
      await this.scheduleRetry(msg, new Date(openUntil));
      return 'retry-later';
    }

    let result: SendResult;
    try {
      result = await postWebhook(
        endpoint.url,
        msg.body,
        {
          [SIGNATURE_HEADER]: signWebhook(msg.body, endpoint.secrets),
          'Marketplace-Event-Id': msg.eventId,
        },
        this.endpoints.ssrfOptions,
      );
    } catch (error) {
      if (!(error instanceof SafeRequestError)) throw error;
      await this.logAttempt(msg, {
        status: 0,
        durationMs: 0,
        snippet: '',
        error: `blocked: ${error.message}`,
      });
      await this.onFailure(msg, endpoint.id);
      return 'blocked';
    }

    const ok = result.status >= 200 && result.status < 300;
    await this.logAttempt(msg, result);
    if (ok) {
      await this.redis.client.del(
        failuresKey(msg.endpointId),
        breakerKey(msg.endpointId),
      );
      await this.endpoints.markHealthy(endpoint.id);
      return 'delivered';
    }

    const disabled = await this.onFailure(msg, endpoint.id);
    if (disabled) return 'disabled';
    if (msg.attempt === 0 && receiveCount < FIFO_RECEIVES) return 'retry-fifo'; // caller throws → SQS redelivers after the visibility timeout
    const delayMin =
      RETRY_SCHEDULE_MIN[Math.min(msg.attempt, RETRY_SCHEDULE_MIN.length - 1)];
    if (msg.attempt >= RETRY_SCHEDULE_MIN.length) return 'skipped'; // exhausted (endpoint disable will follow)
    await this.scheduleRetry(msg, new Date(Date.now() + delayMin * 60_000));
    return 'retry-later';
  }

  /** Manual replay from the dashboard: re-sends the exact stored body (new attempt, same event id). */
  async replay(
    shopId: string,
    endpointId: string,
    eventId: string,
  ): Promise<DeliveryOutcome> {
    const endpoint = await this.endpoints.get(endpointId);
    if (!endpoint || endpoint.shopId !== shopId) return 'skipped';
    const stored = await this.dynamo.doc.send(
      new GetCommand({
        TableName: this.table(),
        Key: { PK: `EP#${endpointId}`, SK: `EVT#${eventId}` },
      }),
    );
    if (!stored.Item) return 'skipped';
    return this.deliver(
      {
        endpointId,
        eventId,
        type: stored.Item.type,
        body: stored.Item.body,
        attempt: 0,
      },
      FIFO_RECEIVES,
    );
  }

  async attempts(endpointId: string, limit = 50) {
    const res = await this.dynamo.doc.send(
      new QueryCommand({
        TableName: this.table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :att)',
        ExpressionAttributeValues: {
          ':pk': `EP#${endpointId}`,
          ':att': 'ATT#',
        },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map(
      ({ PK: _pk, SK: _sk, expiresAtEpoch: _e, ...item }) => item,
    );
  }

  /** Job-lane handler: back into the FIFO as attempt n (fresh dedupe id). */
  async requeue(
    msg: WebhookDelivery,
    enqueue: (m: WebhookDelivery, dedupeId: string) => Promise<void>,
  ) {
    await enqueue(
      { ...msg, attempt: msg.attempt + 1 },
      `${msg.eventId}:${msg.endpointId}:${msg.attempt + 1}`,
    );
  }

  private async onFailure(
    msg: WebhookDelivery,
    endpointId: string,
  ): Promise<boolean> {
    const failures = await this.redis.client.incr(failuresKey(endpointId));
    await this.redis.client.expire(failuresKey(endpointId), 86_400);
    if (failures >= BREAKER_THRESHOLD) {
      const openMs = Math.min(
        BREAKER_BASE_MS * 2 ** (failures - BREAKER_THRESHOLD),
        BREAKER_MAX_MS,
      );
      await this.redis.client.set(
        breakerKey(endpointId),
        String(Date.now() + openMs),
        'PX',
        openMs,
      );
    }
    const failingSince = await this.endpoints.markFailing(endpointId);
    if (Date.now() - failingSince.getTime() < DISABLE_AFTER_MS) return false;

    const disabled = await this.endpoints.disable(
      endpointId,
      'failing for 3 days',
    );
    if (disabled) {
      const owners = await this.sequelize.query<{ userId: string }>(
        `SELECT "userId" FROM "ShopMembership" WHERE "shopId" = :shopId AND role IN ('OWNER', 'ADMIN')`,
        {
          type: QueryTypes.SELECT,
          replacements: { shopId: disabled.shopId },
        },
      );
      await this.notifications.dispatch(
        owners.map(({ userId }) => ({
          type: 'webhooks.endpoint_disabled' as const,
          userId,
          dedupeKey: `wh-disabled:${endpointId}:${failingSince.toISOString()}`,
          data: { url: disabled.url, shopId: disabled.shopId, endpointId },
        })),
      );
      this.logger.warn(
        `webhook endpoint ${endpointId} disabled after 3 days of failures`,
      );
    }
    return true;
  }

  private async scheduleRetry(msg: WebhookDelivery, runAt: Date) {
    await this.jobs.enqueue('webhooks.retry', msg, {
      runAt,
      idempotencyKey: `wh-retry:${msg.eventId}:${msg.endpointId}:${msg.attempt}`,
    });
  }

  private async storeBody(msg: WebhookDelivery) {
    if (msg.attempt > 0) return;
    await this.dynamo.doc
      .send(
        new PutCommand({
          TableName: this.table(),
          Item: {
            PK: `EP#${msg.endpointId}`,
            SK: `EVT#${msg.eventId}`,
            type: msg.type,
            body: msg.body,
            createdAt: new Date().toISOString(),
            expiresAtEpoch: ttl(),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      )
      .catch((e: Error) => {
        if (e.name !== 'ConditionalCheckFailedException') throw e;
      });
  }

  private async logAttempt(msg: WebhookDelivery, result: SendResult) {
    await this.dynamo.doc
      .send(
        new PutCommand({
          TableName: this.table(),
          Item: {
            PK: `EP#${msg.endpointId}`,
            SK: `ATT#${new Date().toISOString()}#${msg.eventId}#${msg.attempt}`,
            eventId: msg.eventId,
            type: msg.type,
            attempt: msg.attempt,
            status: result.status,
            ok: result.status >= 200 && result.status < 300,
            durationMs: result.durationMs,
            ...(result.error && { error: result.error.slice(0, 300) }),
            ...(result.snippet && { responseSnippet: result.snippet }),
            expiresAtEpoch: ttl(),
          },
        }),
      )
      .catch((e: Error) =>
        this.logger.warn(`attempt log failed: ${e.message}`),
      );
  }

  private table() {
    return this.dynamo.table('WebhookAttempts');
  }
}

const breakerKey = (endpointId: string) => `wh:breaker:${endpointId}`;
const failuresKey = (endpointId: string) => `wh:failures:${endpointId}`;
const ttl = () => Math.floor(Date.now() / 1000) + LOG_TTL_DAYS * 86_400;
