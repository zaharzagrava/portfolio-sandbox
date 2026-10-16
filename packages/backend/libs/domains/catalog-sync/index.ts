/**
 * Public entry point of the `catalog-sync` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/catalog-sync`: modules and the rate-limit policy table. No model is exported (IX.4).
 */
export {
  CatalogImportModule,
  CatalogImportProjectorModule,
  CatalogImportWorkerModule,
} from './catalog-import.module';
export {
  IntegrationsModule,
  IntegrationsProjectorModule,
  IntegrationsWorkerModule,
} from './integrations.module';
export {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
} from './sync.module';
export { catalogSyncRatePolicies } from './rate-limit-policies';
export { ImportJobTopicsModule } from './realtime-topics.module';
