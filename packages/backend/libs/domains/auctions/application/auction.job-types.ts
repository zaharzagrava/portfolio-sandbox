import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

const auctionPayload = z.object({ auctionId: z.string().uuid() });
const orderStep = z.enum(['winner', 'second-chance']);
const requestOrderPayload = z.object({
  auctionId: z.string().uuid(),
  step: orderStep,
});
const empty = z.object({});

export type AuctionJobPayload = z.infer<typeof auctionPayload>;
export type RequestOrderPayload = z.infer<typeof requestOrderPayload>;
export {
  auctionPayload as auctionJobPayloadSchema,
  requestOrderPayload as requestOrderPayloadSchema,
};

// Kept apart from the handlers (infra/auction.jobs.ts) so an app that only enqueues (the HTTP side) loads the
// declarations without the worker code. `auctions.second-chance` of the old design is gone: a leftover row of that
// type is rejected by the registry as unknown and dead-lettered.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'auctions.hold-stock': AuctionJobPayload;
    'auctions.open': AuctionJobPayload;
    'auctions.close': AuctionJobPayload;
    'auctions.request-order': RequestOrderPayload;
    'auctions.return-stock': AuctionJobPayload;
    'auctions.sweep-due': Record<string, never>;
    'auctions.ensure-bid-partitions': Record<string, never>;
  }
}

declareJobType({
  name: 'auctions.hold-stock',
  contract: auctionPayload,
  maxAttempts: 5,
});
declareJobType({
  name: 'auctions.open',
  contract: auctionPayload,
  maxAttempts: 5,
});
declareJobType({
  name: 'auctions.close',
  contract: auctionPayload,
  maxAttempts: 5,
});
declareJobType({
  name: 'auctions.request-order',
  contract: requestOrderPayload,
  maxAttempts: 8,
});
declareJobType({
  name: 'auctions.return-stock',
  contract: auctionPayload,
  maxAttempts: 8,
});
declareJobType({ name: 'auctions.sweep-due', contract: empty });
declareJobType({ name: 'auctions.ensure-bid-partitions', contract: empty });
