import { randomUUID } from 'node:crypto';
import {
  auctionMemberSchema,
  flashSaleMemberSchema,
  launchEventSchema,
  liveStreamSchema,
  queueStatusSchema,
  type AuctionMember,
  type FlashSaleMember,
  type LaunchEventDto,
  type LiveStreamDto,
  type QueueStatusDto,
} from '@marketplace-sandbox/contracts';
import type { ControlSurface } from './control-surface';
import { JourneyClient, unique } from './journey-client';
import type { FixtureProduct, SellerFixture } from './seller-fixture';

/**
 * Creation helpers of launch day over the public routes (J03 G-45): an event, a drop, a stream, an auction. Every helper
 * makes its own data with a unique name (L-005, L-006), takes its times from the STACK clock (the journey moves it, the
 * machine's clock is meaningless), and a retried call opens what exists instead of failing (L-010: React effects run
 * twice, hooks are retried; a `409` reads the existing record).
 */
export class LaunchFixture {
  constructor(private readonly control: ControlSurface) {}

  /** The stack's current time in ms. */
  async nowMs(): Promise<number> {
    return Date.parse((await this.control.clock()).now);
  }

  private async at(offsetSeconds: number): Promise<string> {
    return new Date((await this.nowMs()) + offsetSeconds * 1000).toISOString();
  }

  // --- launch events (S22) --------------------------------------------------------------------------------------------

  /** `POST /shops/:shopId/launch-events`; sales open `salesOpensInSec` after the stack's now (default 1 hour). */
  async createEvent(
    seller: SellerFixture,
    options: {
      seatCount?: number;
      seatsPerRow?: number;
      perUserLimit?: number;
      admissionRatePerSec?: number;
      salesOpensInSec?: number;
      startsInSec?: number;
      humanCheckRequired?: boolean;
      title?: string;
    } = {},
  ): Promise<LaunchEventDto> {
    const salesOpensInSec = options.salesOpensInSec ?? 3_600;
    const reply = await seller.owner.post(
      `/api/shops/${seller.shopId}/launch-events`,
      {
        body: {
          title: options.title ?? unique('J03 Launch'),
          venue: 'Journey Hall',
          startsAt: await this.at(
            options.startsInSec ?? salesOpensInSec + 86_400,
          ),
          salesOpenAt: await this.at(salesOpensInSec),
          seatCount: options.seatCount ?? 40,
          seatsPerRow:
            options.seatsPerRow ?? Math.min(10, options.seatCount ?? 40),
          perUserLimit: options.perUserLimit ?? 4,
          admissionRatePerSec: options.admissionRatePerSec ?? 5,
          ...(options.humanCheckRequired !== undefined && {
            humanCheckRequired: options.humanCheckRequired,
          }),
        },
        schema: launchEventSchema,
      },
    );
    if (reply.status !== 201)
      throw new Error(
        `create launch event: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body;
  }

  /** `POST /launch-events/:id/queue`; `201` for a new ticket, `200` for the ticket the buyer already has. */
  async joinQueue(buyer: JourneyClient, eventId: string) {
    const reply = await buyer.post(`/api/launch-events/${eventId}/queue`, {
      body: {},
      schema: queueStatusSchema,
    });
    if (reply.status !== 201 && reply.status !== 200)
      throw new Error(
        `join queue: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body as QueueStatusDto;
  }

  async ticketStatus(
    buyer: JourneyClient,
    eventId: string,
    ticket: string,
  ): Promise<QueueStatusDto> {
    const reply = await buyer.get(
      `/api/launch-events/${eventId}/queue/${ticket}`,
      { schema: queueStatusSchema },
    );
    if (reply.status !== 200)
      throw new Error(
        `ticket status: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body as QueueStatusDto;
  }

  // --- drops (S11) -----------------------------------------------------------------------------------------------------

  /**
   * `POST /shops/:shopId/flash-sales` for `product`. The drop must start at least 2 minutes ahead of the stack clock; the
   * default is 5 minutes, and the window one hour. Returns the member view (`SCHEDULED`).
   */
  async createDrop(
    seller: SellerFixture,
    product: FixtureProduct,
    options: {
      units?: number;
      priceMinor?: number;
      perUserLimit?: number;
      startsInSec?: number;
      durationSec?: number;
      buckets?: number;
    } = {},
  ): Promise<FlashSaleMember> {
    const startsInSec = options.startsInSec ?? 300;
    const reply = await seller.owner.post(
      `/api/shops/${seller.shopId}/flash-sales`,
      {
        body: {
          productId: product.id,
          priceMinor: options.priceMinor ?? Math.max(1, product.priceMinor - 1),
          units: options.units ?? 20,
          ...(options.perUserLimit !== undefined && {
            perUserLimit: options.perUserLimit,
          }),
          ...(options.buckets !== undefined && { buckets: options.buckets }),
          startsAt: await this.at(startsInSec),
          endsAt: await this.at(startsInSec + (options.durationSec ?? 3_600)),
        },
        schema: flashSaleMemberSchema,
      },
    );
    if (reply.status !== 201)
      throw new Error(
        `create drop: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body as FlashSaleMember;
  }

  // --- live streams (S23) ----------------------------------------------------------------------------------------------

  /** `POST /shops/:shopId/live`: a `SCHEDULED` stream (start it with `startStream`). */
  async createStream(
    seller: SellerFixture,
    options: { title?: string; launchEventId?: string } = {},
  ): Promise<LiveStreamDto> {
    const reply = await seller.owner.post(`/api/shops/${seller.shopId}/live`, {
      body: {
        title: options.title ?? unique('J03 Live'),
        ...(options.launchEventId && { launchEventId: options.launchEventId }),
      },
      schema: liveStreamSchema,
    });
    if (reply.status !== 201)
      throw new Error(
        `create stream: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body as LiveStreamDto;
  }

  startStream(actor: JourneyClient, shopId: string, streamId: string) {
    return actor.post(`/api/shops/${shopId}/live/${streamId}/start`);
  }

  // --- auctions (S21) --------------------------------------------------------------------------------------------------

  /**
   * `POST /shops/:shopId/auctions` with its own idempotency key. The shop needs the `auctions` entitlement (a plan that has
   * it: `subscribe(shop)` of the seller kit). Times are the stack's: it starts `startsInSec` from now (default 60 s) and
   * runs `durationSec` (default one hour).
   */
  async createAuction(
    seller: SellerFixture,
    product: FixtureProduct,
    options: {
      title?: string;
      startingPriceMinor?: number;
      minIncrementMinor?: number;
      reservePriceMinor?: number;
      startsInSec?: number;
      durationSec?: number;
      key?: string;
    } = {},
  ): Promise<AuctionMember> {
    const startsInSec = options.startsInSec ?? 300; // S21 refuses a start less than AUCTIONS_MIN_LEAD_S (60 s) ahead
    const reply = await seller.owner.post(
      `/api/shops/${seller.shopId}/auctions`,
      {
        body: {
          productId: product.id,
          title: options.title ?? unique('J03 Auction'),
          startingPriceMinor: options.startingPriceMinor ?? 1_000,
          minIncrementMinor: options.minIncrementMinor ?? 100,
          ...(options.reservePriceMinor !== undefined && {
            reservePriceMinor: options.reservePriceMinor,
          }),
          startsAt: await this.at(startsInSec),
          endsAt: await this.at(startsInSec + (options.durationSec ?? 3_600)),
        },
        key: options.key ?? randomUUID(),
        schema: auctionMemberSchema,
      },
    );
    if (reply.status !== 201 && reply.status !== 200)
      throw new Error(
        `create auction: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body as AuctionMember;
  }
}
