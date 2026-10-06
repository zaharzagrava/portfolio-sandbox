/**
 * Public entry point of the `catalog-sync` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/catalog-sync`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { CatalogImportModule, CatalogImportWorkerModule } from './catalog-import.module';
export { IntegrationsCoreModule, IntegrationsModule, IntegrationsWorkerModule, StockPushProjector } from './integrations.module';
export { OfflineSyncModule } from './sync.module';
export { ImportJobTopicsModule } from './realtime-topics.module';
