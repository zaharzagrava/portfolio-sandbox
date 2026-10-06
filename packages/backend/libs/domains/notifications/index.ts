/**
 * Public entry point of the `notifications` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/notifications`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { formatMoney } from './domain/templates';
export { NotificationsCoreModule } from './notifications-core.module';
export { NotificationsWorkerModule } from './notifications-worker.module';
export { NotificationsModule } from './notifications.module';
export { NotificationRouter } from './application/notification-router.service';
export { NotificationRouterProjector } from './infra/notification-router.projector';
