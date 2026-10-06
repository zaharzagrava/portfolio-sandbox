/**
 * Public entry point of the `seller-insights` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/seller-insights`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { CrawlerModule, CrawlerWorkerModule } from './crawler.module';
export { LeaderboardsWorkerModule } from './leaderboards-worker.module';
export { LeaderboardsModule } from './leaderboards.module';
export { SellerStatsModule } from './seller-stats.module';
export { LeaderboardProjector } from './infra/leaderboard.projector';
export { ShopLiveProjector } from './infra/shop-live.projector';
export { ShopSalesProjector } from './infra/shop-sales.projector';
