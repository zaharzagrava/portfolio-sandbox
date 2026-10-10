import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ShopMembershipModel as ShopMembership } from '@app/domains/tenancy';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderCancelled, OrderPaid } from '@app/domains/orders';
import { AuctionClosed, AuctionLeaderChanged } from '@app/domains/auctions';
import { InvoicePaymentFailed } from '@app/domains/billing';
import { NotificationRouter } from '../application/notification-router.service';
import { formatMoney } from '../domain/templates';
import { NotificationRequest } from '../domain/types';

const short = (id: string) => id.slice(0, 8).toUpperCase();

/**
 * Domain events → notification requests. Domains don't know notifications
 * exist (they just emit facts); this mapping is the only coupling, in one file.
 * Kafka key = aggregate id, so per-order / per-auction events arrive in order.
 */
@Injectable()
export class NotificationRouterProjector implements Projector {
  readonly name = 'notification-router';
  readonly topics = [
    OrderPaid.topic,
    AuctionClosed.topic,
    InvoicePaymentFailed.topic,
  ];
  // Every request carries `dedupeKey = eventId`; the router drops a request it has already dispatched.
  readonly idempotency = 'natural' as const;
  readonly handles = [
    { event: OrderPaid },
    { event: OrderCancelled },
    { event: AuctionClosed },
    { event: AuctionLeaderChanged },
    { event: InvoicePaymentFailed },
  ];

  constructor(
    private readonly router: NotificationRouter,
    @InjectModel(ShopMembership)
    private readonly memberships: typeof ShopMembership,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const requests = (await Promise.all(events.map((e) => this.map(e)))).flat();
    await this.router.dispatch(requests);
  }

  private async map(e: EventEnvelope): Promise<NotificationRequest[]> {
    const base = { dedupeKey: e.eventId, occurredAt: e.occurredAt };

    const paid = OrderPaid.match(e);
    if (paid) {
      return [
        {
          ...base,
          type: 'order.confirmed',
          userId: paid.payload.userId,
          data: {
            orderId: e.aggregateId,
            orderShort: short(e.aggregateId),
            total: formatMoney(
              paid.payload.totalMinor,
              paid.payload.currency ?? 'usd',
              'en-US',
            ),
          },
        },
      ];
    }
    const cancelled = OrderCancelled.match(e);
    if (cancelled) {
      return [
        {
          ...base,
          type: 'order.cancelled',
          userId: cancelled.payload.userId,
          data: {
            orderId: e.aggregateId,
            orderShort: short(e.aggregateId),
            reason: cancelled.payload.reason,
          },
        },
      ];
    }
    const leader = AuctionLeaderChanged.match(e);
    if (leader) {
      return [
        {
          ...base,
          type: 'auction.outbid',
          userId: leader.payload.previousLeaderId,
          data: {
            auctionId: e.aggregateId,
            price: formatMoney(leader.payload.price, 'usd', 'en-US'),
          },
        },
      ];
    }
    const closed = AuctionClosed.match(e);
    if (closed?.payload.winnerId && closed.payload.finalPrice !== null) {
      return [
        {
          ...base,
          type: 'auction.won',
          userId: closed.payload.winnerId,
          data: {
            auctionId: e.aggregateId,
            price: formatMoney(closed.payload.finalPrice, 'usd', 'en-US'),
          },
        },
      ];
    }
    const failed = InvoicePaymentFailed.match(e);
    if (failed) {
      const userIds =
        failed.payload.subjectType === 'USER'
          ? [failed.payload.subjectId]
          : (
              await this.memberships.findAll({
                where: { shopId: failed.payload.subjectId, role: 'OWNER' },
                attributes: ['userId'],
                raw: true,
              })
            ).map((m) => m.userId);
      return userIds.map((userId) => ({
        ...base,
        type: 'billing.payment_failed' as const,
        userId,
        data: { attempt: String(failed.payload.attempt) },
      }));
    }
    return [];
  }
}
