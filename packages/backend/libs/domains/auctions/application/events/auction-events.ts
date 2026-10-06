import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const AuctionClosed = defineEvent('auction.closed', 'auctions', 1, z.object({
  shopId: z.string(),
  productId: z.string(),
  winnerId: z.string().nullable(),
  finalPrice: z.number().int().nullable(),
  reserveMet: z.boolean(),
}));

/** Emitted by the bid relay when the persisted leader changes (SD-17 "you've been outbid"). */
export const AuctionLeaderChanged = defineEvent('auction.leader_changed', 'auctions', 1, z.object({
  previousLeaderId: z.string(),
  leaderId: z.string(),
  /** Minor units, platform currency (auctions are USD-only, like the Stripe integration). */
  price: z.number().int(),
}));
