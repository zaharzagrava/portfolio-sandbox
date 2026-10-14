/**
 * Public entry point of the `experimentation` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/experimentation`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 *
 * Flags (S38): the SDK (`FlagsClient`, `RequireFlag`, its types, `bucketOf`) and the modules that wire it. No repository,
 * model, query helper or infrastructure class leaves the domain.
 */
export { AnalyticsModule } from './analytics.module';
export { ANALYTICS_TOPIC } from './domain/event-schema';
export { FlagsAdminModule } from './flags-admin.module';
export { FlagsSdkModule } from './flags.module';
export { FlagsWorkerModule } from './flags-worker.module';
export { FlagsClient } from './application/flags-client.service';
export { RequireFlag } from './api/flags.guard';
export { bucketOf } from './domain/bucket';
export type { EvalContext, Evaluation, FlagValue } from './domain/evaluator';
export { flagChangedEventSchema } from './domain/flag-events';
export { FlagTopicsModule } from './realtime-topics.module';
export { AnalyticsProjectorModule } from './analytics-projector.module';
export { AnalyticsWorkerModule } from './analytics-worker.module';
export { analyticsRatePolicies } from './rate-limit-policies';
