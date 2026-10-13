/**
 * Public entry point of the `marketing` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/marketing`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 *
 * Share links (S37) export modules, the R1 attribution lookup with its errors, DTO types and the click event
 * contract; the click consumer and every service stay inside the domain.
 */
export { AdsModule, AdsWorkerModule } from './ads.module';
export { ShareLinksModule } from './share-links.module';
export { ShareLinksWorkerModule } from './share-links-worker.module';
export { ShareLinksProjectorModule } from './share-links-projector.module';
export {
  LinkAttributionService,
  TooManyCodesError,
  AttributionUnavailableError,
  type LinkAttribution,
} from './application/link-attribution.service';
export { linkClickedEventSchema } from './domain/link-events';
export type {
  ShortLink,
  ShortLinkPage,
  LinkStats,
  CreateShortLinkRequest,
  UpdateShortLinkRequest,
} from '@marketplace-sandbox/contracts';
