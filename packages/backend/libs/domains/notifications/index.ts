/**
 * Public entry point of the `notifications` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/notifications`. The domain is reached through events: it exports the Nest modules the apps mount
 * and nothing else (no router to call, no models, no formatter). Other domains publish what happened; notifications
 * consumes it.
 */
export { NotificationsModule } from './notifications.module';
export { NotificationsWorkerModule } from './notifications-worker.module';
export { NotificationsProjectorModule } from './notifications-projector.module';
export { TransactionalMailModule } from './transactional-mail.module';
/** The rate-limit policy numbers, registered by the shared test module like every domain's. */
export { notificationsRatePolicies } from './rate-limit-policies';
/** Test support of identity's password-reset specs: the in-memory mailbox the dev/test e-mail provider writes to. */
export { memoryMailbox } from './domain/mailbox';
