import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CONSUMED_EVENT_VERSION,
  consumedEventSchemas,
  inviteRequestedConsumedSchema,
  type ConsumedEventType,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { TransientError } from '@app/infrastructure/projections/errors';
import {
  mapEvent,
  mapInviteRequested,
  type MappedRecipient,
  type MappedRequest,
} from '../domain/event-mapping';
import {
  deadLetterCounter,
  eventsConsumedCounter,
  eventsIgnoredCounter,
  staleVersionDroppedCounter,
} from '../domain/metrics';
import {
  DEAD_LETTER_SINK,
  FOLLOWER_AUDIENCE,
  RECIPIENT_DIRECTORY,
  VERSION_GUARD_STORE,
  type DeadLetterSink,
  type FollowerAudience,
  type RecipientDirectory,
  type VersionGuardStore,
} from '../domain/ports';
import type {
  DeadLetterReason,
  RecipientView,
  RoutingRequest,
} from '../domain/types';
import { scrub } from '../domain/scrub';
import { NotificationRouterService } from './notification-router.service';
import { RecipientViewService } from './recipient-view.service';

/** Name of the single-consumer queue in dead-letter records and metrics. */
export const INVITE_SOURCE = 'tenancy-invite-requested';

const FOLLOWER_PAGE = 1_000;
const PARALLEL = 10;

/** One event after validation, mapping and the version guard. */
interface Accepted {
  event: EventEnvelope;
  requests: MappedRequest[];
}

type Outcome = 'mapped' | 'ignored' | 'dead_lettered' | 'failed';

/** The event being routed and where its failures are collected. */
interface Run {
  source: string;
  event: EventEnvelope;
  failures: unknown[];
}

/**
 * Consume -> validate -> map -> route, per request in isolation (FR-001, FR-004, G-03). A batch is processed whole: one
 * lookup of shop owners and one of users for all its events (FR-007), then every request is rendered before it
 * is acted on, so a request that cannot be rendered is dead-lettered alone and leaves no side effect. A failure of
 * the stores while acting is raised after the rest of the batch was done, as transient: the framework redelivers the batch
 * and every step already done is a no-op (FR-003).
 */
@Injectable()
export class EventRoutingService {
  private readonly logger = new Logger(EventRoutingService.name);

  constructor(
    private readonly views: RecipientViewService,
    private readonly router: NotificationRouterService,
    @Inject(RECIPIENT_DIRECTORY) private readonly directory: RecipientDirectory,
    @Inject(VERSION_GUARD_STORE) private readonly guard: VersionGuardStore,
    @Inject(FOLLOWER_AUDIENCE) private readonly followers: FollowerAudience,
    @Inject(DEAD_LETTER_SINK) private readonly deadLetters: DeadLetterSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `source` is the family of the consumer (`orders`, `identity`, ...): the dead-letter record and the metrics carry it. */
  async consume(source: string, events: EventEnvelope[]): Promise<void> {
    try {
      const accepted: Accepted[] = [];
      for (const event of events) {
        const result = await this.accept(source, event);
        if (result) accepted.push(result);
      }
      await this.route(source, accepted);
    } catch (error) {
      throw asTransient(error);
    }
  }

  /** The invitation message of queue `tenancy-invite-requested`: it carries a token, so nothing of it is logged or kept. */
  async consumeInvite(messageId: string, body: unknown): Promise<void> {
    try {
      const parsed = inviteRequestedConsumedSchema.safeParse(body);
      if (!parsed.success) {
        await this.deadLetter(INVITE_SOURCE, messageId, 'invalid_payload');
        return;
      }
      const request = mapInviteRequested(parsed.data, {
        occurredAt: this.clock.now().toISOString(),
      });
      const plan = await this.tryPlan(
        INVITE_SOURCE,
        messageId,
        undefined,
        this.toRouting(request, request.recipient),
        null,
      );
      if (plan) await this.router.execute(plan);
    } catch (error) {
      throw asTransient(error);
    }
  }

  // ---- intake ----------------------------------------------------------------------------------------------------

  private async accept(
    source: string,
    event: EventEnvelope,
  ): Promise<Accepted | null> {
    const type = event.type as ConsumedEventType;
    const schema = consumedEventSchemas[type] as unknown as
      | { safeParse(input: unknown): { success: boolean; data?: unknown } }
      | undefined;
    if (!schema) {
      eventsIgnoredCounter.add(1, { reason: 'unmapped' });
      eventsConsumedCounter.add(1, { type: 'unmapped', outcome: 'ignored' });
      return null;
    }
    if (event.version !== CONSUMED_EVENT_VERSION) {
      eventsConsumedCounter.add(1, { type, outcome: 'dead_lettered' });
      await this.deadLetter(source, event.eventId, 'unsupported_version', type);
      return null;
    }
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      eventsConsumedCounter.add(1, { type, outcome: 'dead_lettered' });
      await this.deadLetter(source, event.eventId, 'invalid_payload', type);
      return null;
    }

    const mapping = mapEvent(type, parsed.data, {
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      aggregateId: event.aggregateId,
    });
    // The guard sees every versioned event, mapped or not: a `DELIVERED` nobody is told about still outranks a late pickup.
    const stamp = mapping.version;
    if (
      stamp &&
      !(await this.guard.admit(stamp.family, stamp.aggregateId, stamp.version))
    ) {
      staleVersionDroppedCounter.add(1, { family: stamp.family });
      eventsConsumedCounter.add(1, { type, outcome: 'dropped' });
      return null;
    }
    if (mapping.kind === 'ignored') {
      eventsIgnoredCounter.add(1, { reason: mapping.reason });
      eventsConsumedCounter.add(1, { type, outcome: 'ignored' });
      return null;
    }
    return { event, requests: mapping.requests };
  }

  // ---- recipients and routing -----------------------------------------------------------------------------------

  private async route(source: string, accepted: Accepted[]): Promise<void> {
    if (accepted.length === 0) return;
    const recipients = accepted.flatMap((a) =>
      a.requests.map((r) => r.recipient),
    );
    const shopIds = recipients.flatMap((r) =>
      r.kind === 'shopOwners' ? [r.shopId] : [],
    );
    const owners =
      shopIds.length > 0
        ? await this.directory.shopOwners(shopIds)
        : new Map<string, string[]>();
    const userIds = [
      ...recipients.flatMap((r) => (r.kind === 'user' ? [r.userId] : [])),
      ...[...owners.values()].flat(),
    ];
    const views =
      userIds.length > 0
        ? await this.views.views(userIds)
        : new Map<string, RecipientView>();

    const failures: unknown[] = [];
    await mapLimit(accepted, PARALLEL, async ({ event, requests }) => {
      const outcomes: Outcome[] = [];
      for (const request of requests) {
        try {
          outcomes.push(
            ...(await this.routeRequest(
              { source, event, failures },
              request,
              owners,
              views,
            )),
          );
        } catch (error) {
          failures.push(error);
        }
      }
      eventsConsumedCounter.add(1, {
        type: event.type,
        outcome: outcomes.includes('failed')
          ? 'failed'
          : outcomes.includes('mapped')
            ? 'mapped'
            : (outcomes[0] ?? 'ignored'),
      });
    });
    // Acted on what could be; the failure is raised last so the framework retries the batch (every done step is a no-op).
    if (failures.length > 0)
      throw new TransientError(
        `${failures.length} notification request(s) failed; the batch is retried`,
        { cause: failures[0] },
      );
  }

  private async routeRequest(
    run: Run,
    request: MappedRequest,
    owners: Map<string, string[]>,
    views: Map<string, RecipientView>,
  ): Promise<Outcome[]> {
    const { recipient } = request;
    if (recipient.kind === 'followers')
      return this.fanOut(run, request, recipient.accountId);
    const userIds = this.usersOf(recipient, owners);
    if (userIds.length === 0) {
      eventsIgnoredCounter.add(1, { reason: 'no_recipient' });
      return ['ignored'];
    }
    const outcomes: Outcome[] = [];
    for (const userId of userIds)
      outcomes.push(await this.routeTo(run, request, userId, views));
    return outcomes;
  }

  private usersOf(
    recipient: MappedRecipient,
    owners: Map<string, string[]>,
  ): string[] {
    switch (recipient.kind) {
      case 'user':
        return [recipient.userId];
      case 'shopOwners':
        return owners.get(recipient.shopId) ?? [];
      default:
        return [];
    }
  }

  /** Followers are walked in pages of 1,000; a retried event walks them again and creates only what is missing (FR-011). */
  private async fanOut(
    run: Run,
    request: MappedRequest,
    accountId: string,
  ): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.followers.followers(
        accountId,
        FOLLOWER_PAGE,
        cursor,
      );
      const views = await this.views.views(page.userIds);
      for (const userId of page.userIds)
        outcomes.push(await this.routeTo(run, request, userId, views));
      cursor = page.nextCursor;
    } while (cursor);
    if (outcomes.length === 0) outcomes.push('ignored');
    return outcomes;
  }

  private async routeTo(
    run: Run,
    request: MappedRequest,
    userId: string,
    views: Map<string, RecipientView>,
  ): Promise<Outcome> {
    const view = views.get(userId);
    if (!view) {
      eventsIgnoredCounter.add(1, { reason: 'recipient_not_found' });
      return 'ignored';
    }
    const plan = await this.tryPlan(
      run.source,
      run.event.eventId,
      run.event.type,
      this.toRouting(request, { kind: 'user', userId }),
      view,
    );
    if (!plan) return 'dead_lettered';
    try {
      await this.router.execute(plan);
      return 'mapped';
    } catch (error) {
      run.failures.push(error);
      return 'failed';
    }
  }

  /** Render before acting: a failure is this request's alone (AS-12). */
  private async tryPlan(
    source: string,
    eventId: string,
    type: string | undefined,
    routing: RoutingRequest,
    view: RecipientView | null,
  ) {
    try {
      return this.router.plan(routing, view);
    } catch {
      // The error text is dropped on purpose: it may quote data of the recipient or a secret.
      await this.deadLetter(source, eventId, 'render_failed', type);
      return null;
    }
  }

  private toRouting(
    request: MappedRequest,
    recipient: RoutingRequest['recipient'],
  ): RoutingRequest {
    return {
      type: request.type,
      recipient,
      data: request.data,
      sourceId: request.sourceId,
      occurredAt: request.occurredAt,
      ...(request.sourceVersion !== undefined && {
        sourceVersion: request.sourceVersion,
      }),
      ...(request.family && { family: request.family }),
      ...(request.aggregateId && { aggregateId: request.aggregateId }),
    };
  }

  // ---- dead letters ------------------------------------------------------------------------------------------------

  private async deadLetter(
    source: string,
    eventId: string,
    reason: DeadLetterReason,
    type?: string,
  ): Promise<void> {
    deadLetterCounter.add(1, { source, reason });
    this.logger.warn(
      `notifications.event.dead_lettered source=${source} reason=${reason} eventId=${eventId}${type ? ` type=${type}` : ''}`,
    );
    await this.deadLetters.record({
      source,
      reason,
      eventId,
      ...(type && { type }),
      at: this.clock.now(),
    });
  }
}

/** A store that failed is unwell, not the message wrong: the framework pauses and retries instead of dead-lettering. */
function asTransient(error: unknown): Error {
  return error instanceof TransientError
    ? error
    : new TransientError(
        `notification routing failed: ${scrub((error as Error).message)}`,
        {
          cause: error,
        },
      );
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}
