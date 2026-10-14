/**
 * Public entry point of the `auctions` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/auctions`: the modules, the rate-limit policies and the event contracts. No model, repository, job
 * class or fast-store class is exported (S21 FR-039, AS-52).
 */

// Registers the auctions job contracts for any app that enqueues them without loading the handlers.
import './application/auction.job-types';

export { AuctionsWorkerModule } from './auctions-worker.module';
export { AuctionsModule } from './auctions.module';
export { auctionsRatePolicies } from './rate-limit-policies';
export {
  AuctionBidPlaced,
  AuctionCancelled,
  AuctionClosed,
  AuctionCreated,
  AuctionLeaderChanged,
  AuctionOpened,
  AuctionSecondChanceOffered,
  AuctionSold,
  AuctionUnsold,
} from './application/events/auction-events';
export { AuctionTopicsModule } from './realtime-topics.module';
