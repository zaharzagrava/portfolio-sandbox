# Contract: modules, services, jobs, metrics

## Public entry point (`libs/domains/notifications/index.ts`, X.4)

Exports **only**: `NotificationsModule` (HTTP: inbox, preferences, devices, unsubscribe, callbacks, dev mailbox), `NotificationsWorkerModule` (channel workers, callback worker, wake and reconcile job handlers), `NotificationsProjectorModule` (event and queue consumers), `TransactionalMailModule` (existing; binds `PASSWORD_RESET_MAILER`), and the contract types re-exported from `packages/contracts`. **Removed**: `NotificationRouter`, `NotificationRouterProjector`, `NotificationsCoreModule`, `formatMoney`. No R1 export.

Callers to change in the same work:

| Caller | Today | After |
|---|---|---|
| `apps/projector/src/projector.module.ts:12,52` | imports projector class + core module | imports `NotificationsProjectorModule` |
| chat `infra/chat-offline.ts`, `chat-offline-worker.module.ts` | `NotificationRouter.dispatch` | removed; S24 emits `chat.message_escalated` (already does, per spec); specs `chat-sync.e2e-spec.ts:10,108` assert the emitted event |
| seller-insights `application/crawler.service.ts`, `crawler.module.ts` | `dispatch` | emits `seller_insights.competitor_price_dropped` through its outbox; `crawler.e2e-spec.ts:15,59` asserts it |
| developer-platform `application/webhook-deliverer.service.ts`, `webhooks-core.module.ts` | `dispatch` | emits `developer_platform.webhook_endpoint_disabled`; its e2e specs assert it |

Editing those three domains is limited to removing the router call and the module import and emitting the event named; any broader change is a sibling bullet (see gaps.md "Sibling-spec follow-ups").

## Internal application services (not exported)

`EventRoutingService` (consume → map → route per request), `NotificationRouterService` (the idempotent per-request steps), `RecipientViewService`, `InboxService`, `PreferencesService`, `SettingsService` (+ phone verification), `DeviceService`, `UnsubscribeService`, `SuppressionService`, `DeliveryWorkerService`, `CallbackIntakeService`, `CallbackWorkerService`, `UnreadReconcileService`. Controllers inject only these. `application/` imports no `infra/` file; `infra/` implements the ports in `domain/ports.ts`.

## Pure domain modules (unit specs, table-driven)

`event-mapping.ts` (AS-13), `quiet-hours.ts` (AS-33, injected `now`), `backoff.ts` (AS-48, injected `random`), `delivery-status.ts` (AS-71), `templates.ts` + `money.ts` (AS-78..82, AS-81), `catalog.ts`, `cap-window.ts` (rolling window arithmetic mirrored by the script), `unsubscribe-token.ts`, `cursor.ts` (sign/verify), `errors.ts`, `metrics.ts` (names), `ports.ts`.

## Jobs (S49, `declareJobType` with payload contract beside the `JobPayloads` augmentation)

| Job type | Payload | Schedule | Notes |
|---|---|---|---|
| `notifications.wake-delivery` | `{deliveryId}` | enqueue with `runAt` = wake instant, `idempotencyKey = deliveryId`, `maxAttempts: 3` | one job per delayed delivery |
| `notifications.reconcile-unread` | `{}` | every 5 min, `fleetConcurrency: 1` | rebuilds dirty counters |

## Configuration (S54 schema, startup fails)

`NOTIFICATION_SECRET` (required in production, ≥ 32 bytes, distinct from `JWT_*`, session and every other configured secret), `FRONT_BASE_URL`, `SES_*` / `SMTP_*`, `TWILIO_*`, `FCM_*`, `SNS_TOPIC_ARN`, `NOTIFICATIONS_TX_CONCURRENCY` (10), `NOTIFICATIONS_MARKETING_CONCURRENCY` (3), `NOTIFICATIONS_SEND_BUDGET_*`. In production a channel used by the catalog without credentials fails startup (AS-54); outside production stand-ins report `provider: "log"`.

## Metrics (AS-86; names fixed here, labels never carry contact data or ids)

`notifications_events_consumed_total{type,outcome}`, `notifications_events_ignored_total{reason}`, `notifications_dead_letter_total{source,reason}`, `notifications_inbox_created_total{category}`, `notifications_delivery_total{channel,line,status}`, `notifications_delivery_attempt_total{channel,outcome}`, `notifications_failover_total{channel}`, `notifications_provider_circuit_state{provider}` (0 closed, 1 half-open, 2 open), `notifications_capped_total{channel}`, `notifications_quiet_delayed_total{channel}`, `notifications_expired_total{type}`, `notifications_stale_version_dropped_total{family}`, `notifications_realtime_publish_failed_total`, `notifications_unread_rebuilt_total`, `notifications_callbacks_total{provider,outcome}`, `notifications_suppressed_total{channel,reason}`, `notifications_timezone_fallback_total`, `notifications_delivery_latency_seconds{channel,line}`.

Logs: `notifications.event.routed`, `notifications.delivery.sent`, `notifications.delivery.failed` with user id, type, channel, delivery id only; the pino redaction list gains `token`, `resetToken`, `code`, `phone`, `email`, `to`, `body`, `subject`, `Authorization`, `deviceToken`.
