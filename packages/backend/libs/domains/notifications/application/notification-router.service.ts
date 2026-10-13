import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { Channel, staleAfter, typeDef } from '../domain/catalog';
import { CAP_RULES } from '../domain/cap-window';
import type { NotificationTypeDef } from '../domain/catalog';
import {
  resolveChannels,
  unreachableDefaults,
} from '../domain/channel-resolution';
import { deliveryIdFor, identityOf, inboxItemIdFor } from '../domain/ids';
import {
  cappedCounter,
  eventsIgnoredCounter,
  expiredCounter,
  inboxCreatedCounter,
  quietDelayedCounter,
  realtimePublishFailedCounter,
} from '../domain/metrics';
import {
  CAP_STORE,
  COUNTER_STORE,
  DEDUPE_STORE,
  DELIVERY_LINE_PRODUCER,
  DELIVERY_TIMELINE_STORE,
  HELD_DELIVERY_STORE,
  INBOX_STORE,
  REALTIME_NOTIFIER,
  WAKE_SCHEDULER,
  type CapStore,
  type CounterStore,
  type DedupeStore,
  type DeliveryLineProducer,
  type DeliveryTimelineStore,
  type HeldDeliveryStore,
  type InboxStore,
  type RealtimeNotifier,
  type WakeScheduler,
} from '../domain/ports';
import { quietHoursEnd } from '../domain/quiet-hours';
import { scrub } from '../domain/scrub';
import { render, type Rendered } from '../domain/templates';
import type {
  DeliveryMessage,
  RecipientView,
  RoutingRequest,
} from '../domain/types';
import { signUnsubscribe } from '../domain/unsubscribe-token';
import { readNotificationsSettings } from './notifications-settings';
import './notification-delivery.job-types';

/** A queue delay is at most 15 minutes; a longer wait goes through the job scheduler. */
const MAX_LINE_DELAY_S = 900;
/** A held delivery's record outlives its wake instant by this long, so a late or retried job still finds it. */
const HELD_MARGIN_S = 2 * 86_400;

/** What the user lacks when a channel the type uses by default cannot be reached (counted, never an error). */
const UNREACHABLE_REASON: Record<string, string> = {
  email: 'no_email_address',
  sms: 'no_phone',
  push: 'no_device',
};

/** Everything decided about one request before anything is written: rendering and channels. */
export interface RoutePlan {
  request: RoutingRequest;
  /** `<sourceId>|<recipientKey>`: the dedupe identity before the channel. */
  identity: string;
  def: NotificationTypeDef;
  rendered: Rendered;
  /** Allowed channels after preferences and reachability; `inapp` = an inbox item. */
  channels: Channel[];
  view: RecipientView | null;
}

/**
 * The idempotent steps of one notification for one recipient (FR-002, FR-003, FR-010): inbox item, counter, live
 * announcement, then one delivery per external channel handed to its line. Every id is derived from the dedupe identity
 * and every step is safe to repeat after a crash at any point; the `done` marker only short-circuits a replay and
 * is written last (research R-6). `plan` renders and decides without writing anything, so a request that cannot be
 * rendered has no side effect and can be dead-lettered alone (FR-004).
 */
@Injectable()
export class NotificationRouterService {
  private readonly logger = new Logger(NotificationRouterService.name);
  private readonly frontBase: string;
  private readonly backendBase: string;
  private readonly secret: string;

  constructor(
    @Inject(INBOX_STORE) private readonly inbox: InboxStore,
    @Inject(COUNTER_STORE) private readonly counter: CounterStore,
    @Inject(REALTIME_NOTIFIER) private readonly realtime: RealtimeNotifier,
    @Inject(DELIVERY_TIMELINE_STORE)
    private readonly timeline: DeliveryTimelineStore,
    @Inject(DELIVERY_LINE_PRODUCER)
    private readonly lines: DeliveryLineProducer,
    @Inject(DEDUPE_STORE) private readonly dedupe: DedupeStore,
    @Inject(CAP_STORE) private readonly caps: CapStore,
    @Inject(HELD_DELIVERY_STORE) private readonly held: HeldDeliveryStore,
    @Inject(WAKE_SCHEDULER) private readonly wake: WakeScheduler,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ApiConfigService,
  ) {
    const settings = readNotificationsSettings(config);
    this.frontBase = settings.frontBase;
    this.backendBase = settings.backendBase;
    this.secret = settings.secret;
  }

  /** Throws when the request cannot be rendered. Writes nothing. */
  plan(request: RoutingRequest, view: RecipientView | null): RoutePlan {
    const def = typeDef(request.type);
    const rendered = render(
      request.type,
      view?.locale ?? 'en',
      request.data,
      this.frontBase,
    );
    let channels: Channel[];
    if (request.recipient.kind === 'address') {
      // An address has no preferences and no inbox: the e-mail line only (FR-008).
      channels = def.channels.includes('email') ? ['email'] : [];
    } else {
      if (!view) throw new Error('a user recipient needs a recipient view');
      channels = resolveChannels(def, view);
    }
    return {
      request,
      identity: identityOf(request.sourceId, request.recipient),
      def,
      rendered,
      channels,
      view,
    };
  }

  async execute(plan: RoutePlan): Promise<'routed' | 'duplicate'> {
    if (await this.isDone(plan.identity)) return 'duplicate';

    const { request, view } = plan;
    if (view)
      for (const channel of unreachableDefaults(plan.def, view))
        eventsIgnoredCounter.add(1, { reason: UNREACHABLE_REASON[channel] });

    const userId =
      request.recipient.kind === 'user' ? request.recipient.userId : null;
    if (userId && plan.channels.includes('inapp'))
      await this.storeInboxItem(plan, userId);
    for (const channel of plan.channels)
      if (channel !== 'inapp') await this.deliver(plan, channel, userId);

    await this.markDone(plan.identity);
    if (userId)
      this.logger.log(
        `notifications.event.routed userId=${userId} type=${request.type} channels=${plan.channels.join(',')}`,
      );
    return 'routed';
  }

  // ---- inbox, counter, live announcement -------------------------------------------------------------------------------

  private async storeInboxItem(plan: RoutePlan, userId: string): Promise<void> {
    const { request, def, rendered } = plan;
    const now = this.clock.now();
    const eventTime = new Date(request.occurredAt);
    const id = inboxItemIdFor(plan.identity, eventTime);
    const { title, body } = rendered;

    // Marked before the insert: a crash between the insert and the count leaves the user in the dirty set, and the
    // sweep rebuilds the counter from the inbox (AS-62).
    await this.counter.markDirty(userId, now);
    const isNew = await this.inbox.insertIfAbsent({
      id,
      userId,
      type: request.type,
      category: def.category,
      title,
      body,
      link: rendered.link,
      read: false,
      eventTime,
      arrivedAt: now,
    });
    if (!isNew) return; // a replay: the count and the announcement were made by the first run

    await this.counter.increment(userId);
    await this.counter.clearDirty(userId);
    inboxCreatedCounter.add(1, { category: def.category });
    try {
      await this.realtime.notify(userId, {
        id,
        type: request.type,
        category: def.category,
        title,
        body,
        link: rendered.link,
        createdAt: eventTime.toISOString(),
        unread: true,
      });
    } catch (error) {
      realtimePublishFailedCounter.add(1);
      this.logger.warn(
        `notifications.realtime.failed userId=${userId}: ${scrub((error as Error).message)}`,
      );
    }
  }

  // ---- deliveries ------------------------------------------------------------------------------------------------------

  private async deliver(
    plan: RoutePlan,
    channel: Exclude<Channel, 'inapp'>,
    userId: string | null,
  ): Promise<void> {
    const { request, def, rendered, view } = plan;
    const now = this.clock.now();
    const deliveryId = deliveryIdFor(plan.identity, channel);
    const line = def.priority;
    await this.recorded(() =>
      this.timeline.begin(
        { deliveryId, userId, channel, type: request.type, line },
        now,
      ),
    );

    // A fact that is too old is not worth an interruption; its inbox item stays (FR-006).
    const occurredAt = new Date(request.occurredAt);
    const staleAt = staleAfter(request.type, occurredAt, request.data);
    if (now >= staleAt) {
      expiredCounter.add(1, { type: request.type });
      await this.recorded(() =>
        this.timeline.advance(deliveryId, { status: 'expired', at: now }),
      );
      return;
    }

    const message: DeliveryMessage = {
      deliveryId,
      userId: userId ?? '',
      type: request.type,
      channel,
      priority: def.priority,
      to: this.addressesFor(plan, channel),
      subject: rendered.emailSubject,
      html: rendered.emailHtml,
      title: rendered.title,
      body: channel === 'push' ? rendered.pushBody : rendered.body,
      link: rendered.link,
      staleAt: staleAt.toISOString(),
      routedAt: now.toISOString(),
      ...(channel === 'email' &&
        !def.mandatory &&
        userId && {
          unsubscribeUrl: `${this.backendBase}/api/notifications/unsubscribe?token=${signUnsubscribe(userId, def.category, this.secret)}`,
        }),
    };

    // A marketing delivery takes a slot of the rolling cap before anything else is decided; a store that cannot answer
    // throws, so nothing is sent without a decision and the event is retried (FR-026, AS-39).
    const rule = def.priority === 'marketing' ? CAP_RULES[channel] : undefined;
    if (userId && rule) {
      const decision = await this.caps.admit({
        userId,
        channel,
        deliveryId,
        limit: rule.limit,
        windowMs: rule.windowMs,
        now,
      });
      if (decision === 'reject') {
        cappedCounter.add(1, { channel });
        await this.recorded(() =>
          this.timeline.advance(deliveryId, { status: 'capped', at: now }),
        );
        return;
      }
    }

    // Quiet hours hold push and SMS only; mandatory notices and the inbox never wait (FR-021, FR-022).
    const wakeAt =
      view && !def.mandatory && (channel === 'push' || channel === 'sms')
        ? quietHoursEnd(now, {
            timezone: view.timezone,
            start: view.quietStart,
            end: view.quietEnd,
          })
        : null;
    if (!wakeAt) {
      await this.lines.enqueue(line, channel, message, {
        dedupeId: deliveryId,
      });
      return;
    }
    quietDelayedCounter.add(1, { channel });
    const delaySeconds = Math.max(
      Math.ceil((wakeAt.getTime() - now.getTime()) / 1000),
      0,
    );
    if (delaySeconds <= MAX_LINE_DELAY_S)
      await this.lines.enqueue(line, channel, message, {
        dedupeId: deliveryId,
        delaySeconds,
      });
    else {
      // One job per delivery; its payload is the delivery id, so the message waits in the held store (written first).
      await this.held.put(
        deliveryId,
        { line, message, staleAt, wakeAt },
        delaySeconds + HELD_MARGIN_S,
      );
      await this.wake.schedule(deliveryId, wakeAt);
    }
    await this.recorded(() =>
      this.timeline.advance(deliveryId, {
        status: 'delayed',
        detail: wakeAt.toISOString(),
        at: now,
      }),
    );
  }

  private addressesFor(
    plan: RoutePlan,
    channel: Exclude<Channel, 'inapp'>,
  ): string[] {
    const { request, view } = plan;
    if (request.recipient.kind === 'address')
      return [request.recipient.email.trim().toLowerCase()];
    if (channel === 'email') return view?.email ? [view.email] : [];
    if (channel === 'sms') return view?.phone ? [view.phone] : [];
    return (view?.devices ?? []).map((d) => d.token);
  }

  // ---- shortcuts and best-effort writes -------------------------------------------------------------------------------

  /** A lost marker only costs a repeat of idempotent steps: a store error here never fails routing. */
  private async isDone(identity: string): Promise<boolean> {
    try {
      return await this.dedupe.isDone(identity);
    } catch (error) {
      this.logger.warn(
        `done marker unreadable: ${scrub((error as Error).message)}`,
      );
      return false;
    }
  }

  private async markDone(identity: string): Promise<void> {
    try {
      await this.dedupe.markDone(identity);
    } catch (error) {
      this.logger.warn(
        `done marker not written: ${scrub((error as Error).message)}`,
      );
    }
  }

  /** A timeline write must never fail or repeat a send (FR-012). */
  private async recorded(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn(
        `delivery timeline write failed: ${scrub((error as Error).message)}`,
      );
    }
  }
}
