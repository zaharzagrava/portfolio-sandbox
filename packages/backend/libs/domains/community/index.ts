/**
 * Public entry point of the `community` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/community`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { DiscussionsWorkerModule } from './discussions-worker.module';
export { DiscussionsModule } from './discussions.module';
export { communityRatePolicies } from './rate-limit-policies';
export { FeedPublisherModule } from './feed-publisher.module';
export { FeedModule } from './feed.module';
export { FeedFanoutConsumer } from './infra/fanout.consumer';
export { ProductFeedProjector } from './infra/product-feed.projector';
