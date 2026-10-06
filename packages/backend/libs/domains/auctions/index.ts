/**
 * Public entry point of the `auctions` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/auctions`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { default as AuctionModel } from './infra/models/auction.model';
export { AuctionsWorkerModule } from './auctions-worker.module';
export { AuctionsModule } from './auctions.module';
export { AuctionClosed, AuctionLeaderChanged } from './application/events/auction-events';
export { AuctionTopicsModule } from './realtime-topics.module';
