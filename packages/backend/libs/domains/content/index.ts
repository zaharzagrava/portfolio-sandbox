/**
 * Public entry point of the `content` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/content`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { StoriesModule, StoriesWorkerModule, StoryCacheInvalidator, StoryCacheModule } from './stories.module';
