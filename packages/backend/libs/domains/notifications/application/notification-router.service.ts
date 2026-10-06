import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { Channel, typeDef } from '../domain/catalog';
import { render } from '../domain/templates';
import { quietHoursEnd } from '../domain/quiet-hours';
import { NotificationPreferencesService } from './preferences.service';
import { InboxService } from './inbox.service';
import { DeliveryLogService } from '../infra/delivery-log.service';
import { signUnsubscribe } from '../domain/unsubscribe-token';
import { DeliveryMessage, NOTIFICATION_QUEUES, NotificationRequest, Recipient } from '../domain/types';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    /** Quiet-hours delays longer than SQS's 15-minute max. */
    'notifications.deliver': { queue: string; message: DeliveryMessage };
  }
}

/** Marketing frequency caps per user (transactional is never capped). */
const MARKETING_CAPS: Partial<Record<Channel, { limit: number; windowSec: number }>> = {
  push: { limit: 3, windowSec: 3_600 },
  email: { limit: 2, windowSec: 86_400 },
  sms: { limit: 1, windowSec: 86_400 },
};
const SQS_MAX_DELAY_SEC = 900;
const DONE_TTL_SEC = 7 * 86_400;

export const deliveryIdFor = (dedupeKey: string, userId: string, channel: string) =>
  createHash('sha256').update(`${dedupeKey}:${userId}:${channel}`).digest('hex').slice(0, 32);

/**
 * "Tell user X about Y" → per-channel work (10/02 Ex4):
 *  preferences → render once per locale → in-app inbox now → for each external
 *  channel: frequency cap (marketing) → quiet hours (push/sms) → its own SQS
 *  queue (bulkhead: an SMS provider outage backs up only the SMS queue).
 *
 * Every derived id is deterministic (inbox row, delivery id), so replaying an
 * event after a crash re-does the same work idempotently; the "done" marker
 * is only a fast path, written last.
 */
@Injectable()
export class NotificationRouter {
  private readonly logger = new Logger(NotificationRouter.name);
  private readonly frontHost: string;
  private readonly backendHost: string;
  private readonly secret: string;

  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly inbox: InboxService,
    private readonly deliveryLog: DeliveryLogService,
    private readonly redis: RedisService,
    private readonly queue: TaskQueue,
    private readonly jobs: JobsService,
    config: ApiConfigService,
  ) {
    this.frontHost = config.get('front_host');
    this.backendHost = config.get('backend_host');
    this.secret = config.get('notification_secret') ?? config.get('jwt_secret');
  }

  async dispatch(requests: NotificationRequest[]): Promise<void> {
    if (requests.length === 0) return;
    const recipients = await this.preferences.recipients(requests.map((r) => r.userId));
    for (let i = 0; i < requests.length; i += 50) {
      await Promise.all(requests.slice(i, i + 50).map((request) => this.dispatchOne(request, recipients.get(request.userId))));
    }
  }

  private async dispatchOne(request: NotificationRequest, recipient: Recipient | undefined): Promise<void> {
    if (!recipient) return;
    const doneKey = `notif:done:${request.dedupeKey}:${request.userId}`;
    if (await this.redis.client.exists(doneKey)) return;

    const def = typeDef(request.type);
    const rendered = render(request.type, recipient.locale, request.data, this.frontHost);
    const channels = this.preferences.channelsFor(request.type, recipient);
    const occurredAt = request.occurredAt ? new Date(request.occurredAt) : new Date();

    if (channels.includes('inapp')) {
      await this.inbox.add(request.userId, request.dedupeKey, occurredAt, { type: request.type, category: def.category, title: rendered.title, body: rendered.body, link: rendered.link });
    }

    for (const channel of channels.filter((c): c is DeliveryMessage['channel'] => c !== 'inapp')) {
      const deliveryId = deliveryIdFor(request.dedupeKey, request.userId, channel);
      const log = { deliveryId, userId: request.userId, channel, type: request.type };

      if (def.priority === 'marketing' && !(await this.underCap(request.userId, channel))) {
        await this.deliveryLog.record({ ...log, status: 'capped' });
        continue;
      }

      const message: DeliveryMessage = {
        deliveryId,
        userId: request.userId,
        type: request.type,
        channel,
        priority: def.priority,
        to: channel === 'email' ? [recipient.email!] : channel === 'sms' ? [recipient.phone!] : recipient.pushTokens,
        subject: rendered.emailSubject,
        html: rendered.emailHtml,
        title: rendered.title,
        body: rendered.body,
        link: rendered.link,
        ...(channel === 'email' && !def.mandatory && { unsubscribeUrl: `${this.backendHost}/api/notifications/unsubscribe?token=${signUnsubscribe(request.userId, def.category, this.secret)}` }),
      };
      const queue = def.priority === 'marketing' ? NOTIFICATION_QUEUES.marketing : NOTIFICATION_QUEUES[channel];

      // Quiet hours for the intrusive channels only; email and the inbox wait silently anyway.
      const wakeAt = channel === 'push' || channel === 'sms' ? quietHoursEnd(new Date(), { timezone: recipient.timezone, start: recipient.quietStart, end: recipient.quietEnd }) : null;
      if (!wakeAt) {
        await this.queue.enqueue(queue, message);
        await this.deliveryLog.record({ ...log, status: 'queued' });
        continue;
      }
      const delaySec = Math.ceil((wakeAt.getTime() - Date.now()) / 1000);
      if (delaySec <= SQS_MAX_DELAY_SEC) await this.queue.enqueue(queue, message, { delaySeconds: Math.max(delaySec, 0) });
      else await this.jobs.enqueue('notifications.deliver', { queue, message }, { runAt: wakeAt, idempotencyKey: `notif-deliver:${deliveryId}` });
      await this.deliveryLog.record({ ...log, status: 'delayed', detail: wakeAt.toISOString() });
    }

    await this.redis.client.set(doneKey, '1', 'EX', DONE_TTL_SEC);
  }

  private async underCap(userId: string, channel: Channel): Promise<boolean> {
    const cap = MARKETING_CAPS[channel];
    if (!cap) return true;
    const window = Math.floor(Date.now() / 1000 / cap.windowSec);
    const key = `notif:cap:{${userId}}:${channel}:${window}`;
    const [[, count]] = (await this.redis.client.multi().incr(key).expire(key, cap.windowSec).exec()) as [[null, number], unknown];
    return count <= cap.limit;
  }
}
