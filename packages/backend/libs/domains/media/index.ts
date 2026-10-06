/**
 * Public entry point of the `media` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/media`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { MediaModule } from './media.module';
export { VideoModule, VideoWorkerModule } from './video.module';
export { MediaProcessor } from './infra/media-processor';
export type { Sql } from './infra/media-processor';
