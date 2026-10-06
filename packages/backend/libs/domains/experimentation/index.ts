/**
 * Public entry point of the `experimentation` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/experimentation`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { AnalyticsModule } from './analytics.module';
export { ANALYTICS_TOPIC } from './domain/event-schema';
export { FlagsAdminModule } from './flags-admin.module';
export { FlagsSdkModule } from './flags.module';
export { PurchaseEventsProjector } from './infra/purchase-events.projector';
export { FlagTopicsModule } from './realtime-topics.module';
