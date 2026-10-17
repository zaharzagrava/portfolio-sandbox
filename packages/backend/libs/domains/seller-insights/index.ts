/**
 * Public entry point of the `seller-insights` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/seller-insights`. Only the modules the apps wire are exported: no model, no consumer class (S40 D-8);
 * the consumers are listed by `SellerInsightsProjectorModule.projectors`.
 */
export { CrawlerModule, CrawlerWorkerModule } from './crawler.module';
export { LeaderboardsWorkerModule } from './leaderboards-worker.module';
export { LeaderboardsModule } from './leaderboards.module';
export { SellerStatsModule } from './seller-stats.module';
export { SellerInsightsProjectorModule } from './seller-insights-projector.module';
