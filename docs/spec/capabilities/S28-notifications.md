---
id: S28
title: Notification routing, preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression
kind: capability
status: draft
generated_at: 3aec9f4
depends_on: [S01, S03, S10, S13, S49, S50, S51, S52, S53, S54]
concepts: [outbox-task-queue, projection-and-replay, rate-limit-policy, job-scheduler-lease, realtime-topic-stream, cache-layers, problem-json-errors, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/notifications/**
  - packages/contracts/src/notifications/**
---
# S28 - Notification routing, preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression

## Purpose
A fact happens on the platform and the right people hear about it exactly once, in their language, on the channels they chose, at a time that respects them. Other capabilities only publish events; this one turns them into an inbox item, a bell update and queued e-mail, SMS or push messages. A provider outage or a marketing campaign never blocks the rest, and bad addresses stop receiving mail for good. See {{concept:projection-and-replay}}, {{concept:rate-limit-policy}}, {{concept:job-scheduler-lease}} and {{concept:realtime-topic-stream}}.

## Entry points
- Event consumers, one per source family over the S53 framework, plus the SQS queue `tenancy-invite-requested`: identity, tenancy, shop onboarding, orders, payments, delivery, auctions, billing, payouts, launch events, chat, discussions, seller insights, developer platform and feed. [proof: S28 AS-01, S28 AS-08]
- `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/read`: the caller's inbox and bell. [code: packages/backend/libs/domains/notifications/api/notifications.controller.ts#NotificationsController]
- `GET` and `PUT /notifications/preferences`, `PUT /notifications/settings`: preferences and quiet hours. [proof: S28 AS-14, S28 AS-15, S28 AS-16, S28 AS-19, S28 AS-20]
- Phone verification: request a code and verify it, both under the settings path of the same controller (added with the preferences work). [proof: S28 AS-21, S28 AS-22, S28 AS-23]
- `GET` and `POST /notifications/devices`, `DELETE /notifications/devices/:deviceId`: push devices. [proof: S28 AS-28, S28 AS-29]
- `GET` and `POST /notifications/unsubscribe?token=`: one-click unsubscribe, anonymous. [proof: S28 AS-25, S28 AS-26]
- `POST /notifications/webhooks/ses` and `POST /notifications/webhooks/twilio`: provider callbacks. [code: packages/backend/libs/domains/notifications/api/notification-webhooks.controller.ts#NotificationWebhooksController]
- Delivery lines `notify-{email,sms,push}` and `notify-marketing-{email,sms,push}`, the queue `notifications-callbacks` and the jobs `notifications.wake-delivery` and `notifications.reconcile-unread`. [proof: none]
- `PASSWORD_RESET_MAILER` port bound by `TransactionalMailModule`, and `GET /dev/mailbox` outside production. [code: packages/backend/libs/domains/notifications/api/dev-mailbox.controller.ts#DevMailboxController]
- Realtime out: event `notification` on the owner-only topic `user:<userId>`.

## Rules
### Intake and routing
- **S28.R-01** The consumer MUST validate each payload against the schema of its type, map it to zero or more notification requests, ignore a known-unmapped type with a counter, and dead-letter a malformed payload or an unsupported version with a reason and the event id. [proof: S28 AS-04, S28 AS-05, S28 AS-13]
- **S28.R-02** A notification MUST have one dedupe identity: source event id (or the owner's own key), recipient and channel. Processing it again, in sequence or at once, MUST create no second inbox item, delivery, realtime event or count. [proof: S28 AS-02]
- **S28.R-03** Each routing step MUST be safe to repeat after a crash at any point, so that the final state equals one uninterrupted run; the done marker is a shortcut and never the only guard. [proof: S28 AS-03]
- **S28.R-04** A request that cannot be rendered MUST be dead-lettered without side effects and MUST NOT affect the other requests of its batch. [proof: S28 AS-12]
- **S28.R-05** For an aggregate with a monotonic version, the consumer MUST drop an event whose version is lower than the highest one already notified for that aggregate and family. [proof: S28 AS-10]
- **S28.R-06** An event older than the maximum age of its type MUST NOT cause an external delivery (timeline `expired`) but MUST still create its inbox item; a delivery held for quiet hours MUST re-check the age at its wake instant. [proof: S28 AS-11, S28 AS-34]
- **S28.R-07** Recipients MUST be resolved only through the exported services of identity and tenancy, batched once per consumed batch with at most 500 ids per call; an unknown user produces nothing. [proof: S28 AS-06, S28 AS-07]
- **S28.R-08** A notification addressed to an e-mail address (an invitation) MUST go to the e-mail line only, with no inbox item and no preference lookup, and stays subject to suppression. [proof: S28 AS-08]
- **S28.R-09** A notification MUST be rendered once per recipient in the recipient's locale at routing time; money MUST be formatted from integer minor units and a currency code. [proof: S28 AS-01]
- **S28.R-10** Per recipient the router MUST create the inbox item first, then for each other allowed channel apply the marketing cap and quiet hours, then hand the delivery to its line; a failed step leaves the earlier steps intact and the event retriable. [proof: S28 AS-03, S28 AS-30, S28 AS-35]
- **S28.R-11** Follower fan-out of a marketing notice MUST be resumable and idempotent: a retry walks the followers again and creates only what is missing. [proof: none]
- **S28.R-12** Each delivery MUST have a timeline with the statuses `queued`, `delayed`, `sent`, `delivered`, `bounced`, `complained`, `failed`, `suppressed`, `capped`, `skipped` and `expired`; a timeline write failure MUST NOT fail or repeat a send. [proof: none]
- **S28.R-13** Secrets (reset and invite tokens, one-time codes, unsubscribe tokens) MUST appear only in the message handed to the provider, never in logs, timeline, metrics, dead-letter records or inbox items. [proof: S28 AS-09]
- **S28.R-14** The password-reset mail MUST go through the `PASSWORD_RESET_MAILER` port with the link `<front>/reset-password#token=<token>`, using the catalog template and redaction. [proof: S28 AS-09]

### Preferences, settings, phone, devices
- **S28.R-15** The preference matrix MUST hold one boolean per category and channel; a stored value is an explicit override, and marketing external channels and SMS default to off. [proof: S28 AS-14]
- **S28.R-16** `GET` and `PUT` of preferences and settings MUST return the full matrix, be idempotent, and report `mandatoryChannels` and a masked phone. [proof: S28 AS-14, S28 AS-15, S28 AS-21]
- **S28.R-17** A mandatory type MUST ignore category and channel opt-outs and quiet hours, and MUST NOT ignore suppression. [proof: S28 AS-17]
- **S28.R-18** Enabling SMS for any category MUST require a verified phone, otherwise the answer is `422 phone_not_verified`. [proof: S28 AS-18]
- **S28.R-19** Phone ownership MUST be proven by a six-digit code valid 10 minutes, with 5 failed attempts locking for 15 minutes and 3 code requests per hour; changing the phone clears the verification. [proof: S28 AS-21, S28 AS-22, S28 AS-23]
- **S28.R-20** After a preference or settings write, no process MUST route with the previous values: the recipient view is invalidated on write and lives at most 5 minutes. [proof: S28 AS-15, S28 AS-19]
- **S28.R-21** Quiet hours MUST be set and cleared as a pair (`quietStart`, `quietEnd` as `HH:MM`, not equal), the time zone MUST be an IANA name, and the locale MUST be `en` or `uk`; the store enforces the pair with a CHECK constraint. [proof: S28 AS-20]
- **S28.R-22** A device registration MUST move a known token to the latest registering user, keep at most 10 devices per user by evicting the oldest, and never return the token; removal is by device id and owner only. [proof: S28 AS-28, S28 AS-29]
- **S28.R-23** `GET /notifications/unsubscribe` MUST only describe the action. `POST` MUST switch off the e-mail channel of the category named in a signed, non-expiring token. Every bad token answers `400 invalid_unsubscribe_token` without a reason. [code: packages/backend/libs/domains/notifications/domain/unsubscribe-token.ts] [proof: S28 AS-25, S28 AS-26]
- **S28.R-24** An e-mail of a non-mandatory type MUST carry the signed unsubscribe URL and the one-click headers; a mandatory type MUST carry neither. [proof: S28 AS-27]

### Quiet hours and caps
- **S28.R-25** Quiet hours MUST delay push and SMS only, in the recipient's time zone, correct across daylight-saving changes and overnight windows, using the injected clock. [code: packages/backend/libs/domains/notifications/domain/quiet-hours.ts#quietHoursEnd] [proof: S28 AS-30, S28 AS-32, S28 AS-33]
- **S28.R-26** A delay up to 900 seconds MUST use the queue delay; a longer delay MUST use exactly one scheduled job `notifications.wake-delivery` per delivery. [proof: S28 AS-30, S28 AS-31]
- **S28.R-27** At its wake instant a delayed delivery MUST be re-checked for maximum age, suppression and the user's current preference. [proof: S28 AS-34, S28 AS-51, S28 AS-52]
- **S28.R-28** Marketing deliveries MUST obey a rolling per-user, per-channel cap: push 3 per hour, e-mail 2 per 24 hours, SMS 1 per 24 hours; transactional deliveries MUST NOT be capped. A capped delivery is recorded `capped` and not queued; its inbox item stays. [proof: S28 AS-35, S28 AS-38]
- **S28.R-29** The cap decision MUST be atomic under concurrency, final per delivery id, and fail closed for marketing when the counting store is down. [proof: S28 AS-36, S28 AS-37, S28 AS-39]

### Lines, providers, failover
- **S28.R-30** E-mail, SMS and push MUST each have a line, and marketing MUST have its own line per channel with lower worker capacity, so a backlog or outage on one line never delays another. [proof: S28 AS-40, S28 AS-41]
- **S28.R-31** Each provider MUST have a send budget enforced by the rate limiter; a delivery over budget returns to its line with the retry-after delay and uses no attempt. With the limiter down, transactional sends fail open and marketing sends fail closed. [proof: S28 AS-42, S28 AS-43]
- **S28.R-32** Each channel MUST have an ordered provider chain. A transient failure or a timeout of 10 seconds MUST fail over to the next provider in the same attempt, and a circuit breaker MUST skip an open provider until its probe. [proof: S28 AS-44, S28 AS-45, S28 AS-53]
- **S28.R-33** A permanent provider failure MUST NOT fail over or retry: the address is suppressed or the dead push token removed, and the delivery is `failed`. [proof: S28 AS-46]
- **S28.R-34** A transient failure of the whole chain MUST retry through the line with exponential backoff (base 30 s, factor 2, cap 900 s, full jitter) for at most 5 attempts, then dead-letter as `failed` with reason `exhausted`. [proof: S28 AS-47, S28 AS-48]
- **S28.R-35** A delivery already sent MUST never be handed to a provider again, including under concurrent copies; a malformed queue message is dead-lettered without its body. [proof: S28 AS-49, S28 AS-50]
- **S28.R-36** Before each send the worker MUST check suppression, the user's current preference (non-mandatory types only) and the maximum age. [proof: S28 AS-34, S28 AS-51, S28 AS-52]
- **S28.R-37** In production, startup MUST fail when a channel used by the catalog has no provider credentials or `NOTIFICATION_SECRET` is missing or shared with another secret; stand-ins outside production report `provider: "log"` and never `delivered`. [proof: S28 AS-54]

### Inbox and bell
- **S28.R-38** `GET /notifications` MUST return the caller's items only, newest first by event time then id, with signed cursors bound to the caller, limit 1 to 50 (default 20) and 180-day retention. [proof: S28 AS-55, S28 AS-56, S28 AS-64]
- **S28.R-39** The unread count MUST equal the number of the caller's unread items bounded at 1,000, be read in constant time, rebuild after the loss of its store, and be repaired within 5 minutes after a crash between store and count. [proof: S28 AS-57, S28 AS-61, S28 AS-62]
- **S28.R-40** Marking read MUST be idempotent, owner-scoped and safe under concurrency with one decrement per item; mark-all MUST use a watermark and leave later arrivals unread. [proof: S28 AS-58, S28 AS-59, S28 AS-60]
- **S28.R-41** A new inbox item MUST be announced on the owner's private realtime topic, event `notification`, on a best-effort basis: a hub failure MUST NOT fail routing. [proof: S28 AS-01, S28 AS-63]
- **S28.R-42** Inbox text MUST be fixed in the locale of its creation, with titles up to 120 and bodies up to 500 characters and a relative link built by the catalog; a user MAY switch the in-app channel off per category. [proof: S28 AS-65, S28 AS-66]

### Callbacks and suppression
- **S28.R-43** Suppression MUST be per channel and normalized address (e-mail trimmed and lower-cased, phone in E.164), idempotent, in effect for the next send, and honoured by every type including mandatory ones. [proof: S28 AS-17, S28 AS-76]
- **S28.R-44** A provider callback MUST be authenticated by the provider's scheme, acknowledged `2xx` only after durable acceptance, deduplicated on the provider's event id and applied once by the worker. An SNS message older or newer than 5 minutes MUST be refused. [proof: S28 AS-69, S28 AS-70, S28 AS-75]
- **S28.R-45** Callback processing MUST NOT call a URL taken from the callback unless it is HTTPS on the pinned provider host. [proof: S28 AS-73]
- **S28.R-46** A complaint, a permanent bounce, an SMS STOP and a permanent provider error MUST suppress the address; a complaint MUST also switch off the user's marketing e-mail when the user is known. [proof: S28 AS-67, S28 AS-68, S28 AS-74, S28 AS-77]
- **S28.R-47** A delivery status MUST only move forward by rank (`queued` 0, `delayed` 1, `sent` 2, `delivered` 3, `bounced` 4, `complained` 5); a pre-send terminal status (`suppressed`, `capped`, `skipped`, `expired`) is reachable only from `queued` or `delayed`. A callback that arrives before the provider message id is recorded MUST be retried for up to 10 minutes, then dropped and counted. [proof: S28 AS-71, S28 AS-72]

### Templates
- **S28.R-48** Templates MUST be logic-less `{{variable}}` text per type and locale; HTML values are escaped, a missing variable fails the render, and the locale resolves as exact, then language, then English. [proof: S28 AS-78, S28 AS-79, S28 AS-80]
- **S28.R-49** Subjects MUST have CR and LF removed, push and inbox text MUST respect their length limits, and links MUST come from the catalog path templates with identifiers made of letters, digits, `_` and `-` only. [proof: S28 AS-82]
- **S28.R-50** The catalog MUST hold every notification type with its category (one of 13), default channels, mandatory flag, recipient rule, maximum age, line, link and `en` and `uk` templates. [code: packages/backend/libs/domains/notifications/domain/catalog.ts] [proof: S28 AS-87]
- **S28.R-56** Money in a message MUST be formatted from integer minor units with the currency's own number of decimals in the recipient's locale, and a non-integer amount MUST fail the render. [proof: S28 AS-81]

### Boundaries and operations
- **S28.R-51** The capability MUST read and write only the tables it owns (`NotificationPreference`, `NotificationSettings`, `NotificationSuppression`, `PushDevice`) and its own inbox, timeline and counter stores; other data enters through exported services or events. [proof: none]
- **S28.R-52** The public entry point MUST export only the module classes, the rate-limit policies and the in-memory mailbox of the dev and test e-mail provider, no router service, projector class, formatter or model. [code: packages/backend/libs/domains/notifications/index.ts] [proof: none]
- **S28.R-53** Every endpoint except unsubscribe and callbacks MUST authenticate, take the principal from the session, answer errors as `application/problem+json` with a stable code, and apply the rate-limit policies of the domain ({{concept:problem-json-errors}}). [code: packages/backend/libs/domains/notifications/rate-limit-policies.ts] [proof: none]
- **S28.R-54** Logs MUST be structured and carry no contact data, token or message body; the metrics listed in the service contract MUST exist under their fixed names with bounded labels. [proof: S28 AS-85, S28 AS-86]
- **S28.R-55** Transactions MUST go through the transaction runner only ({{concept:transaction-runner}}), and the domain MUST NOT open a transaction on its own. [proof: none]

## Behaviors
- **S28.B-01** Given a paid order, when `order.paid` is consumed, then the buyer has one inbox item, an unread count of 1, a queued confirmation e-mail and a live `notification` event. [proof: S28 AS-01]
- **S28.B-02** Given the same event delivered 20 times at once, then exactly one inbox item, one delivery and one count exist. [proof: S28 AS-02]
- **S28.B-03** Given a queue that refuses once, when the event is replayed, then the final state equals one uninterrupted run. [proof: S28 AS-03]
- **S28.B-04** Given a batch with a malformed payload, then it is dead-lettered with a reason and the other requests of the batch complete. [proof: S28 AS-04]
- **S28.B-05** Given an invitation event, then one e-mail with the link `<front>/invites/<token>` is queued and no inbox item exists. [proof: S28 AS-08]
- **S28.B-06** Given an outbid event during quiet hours, then the inbox item exists at once and the push is delayed to the end of the window. [proof: S28 AS-30, S28 AS-31]
- **S28.B-07** Given four marketing e-mails in 24 hours for one user, then the third is recorded `capped` and the inbox item is still created. [proof: S28 AS-38]
- **S28.B-08** Given the SMS provider fails, when one event has e-mail and SMS, then the e-mail is sent and the SMS retries with backoff. [proof: S28 AS-40, S28 AS-47]
- **S28.B-09** Given the primary e-mail provider fails with a transient error, then the same attempt sends through the fallback provider and the timeline records `failover`. [proof: S28 AS-44]
- **S28.B-10** Given three unread items, when the user marks one read and then all, then the count goes 2 then 0 and a later arrival counts 1. [proof: S28 AS-58, S28 AS-60]
- **S28.B-11** Given a signed SES complaint for a delivered e-mail, then the address is suppressed, marketing e-mail is switched off, and the next event calls no provider. [proof: S28 AS-67]
- **S28.B-15** Given the same signed callback posted ten times at once, then `200` is answered each time and its effects are applied once. [proof: S28 AS-70]
- **S28.B-16** Given a bank that asks for confirmation of a subscription payment, then the Ukrainian user reads that text and not the generic one. [proof: S28 AS-87]
- **S28.B-12** Given a user opens an unsubscribe link, then `GET` changes nothing and `POST` switches off e-mail for that category only. [proof: S28 AS-25]
- **S28.B-13** Given a user enables SMS without a verified phone, then the answer is `422 phone_not_verified` and the matrix is unchanged. [proof: S28 AS-18]
- **S28.B-14** Given a registered token, when another user registers it, then the token belongs to the latest user and the first user lists no device for it. [proof: S28 AS-28]

## Owns
- Tables: `NotificationPreference`, `NotificationSettings`, `NotificationSuppression`, `PushDevice`.
- Wide-column store: the inbox, the inbox read watermark, the delivery timeline and the provider-message lookup.
- Redis: done markers, version guard, caps, unread counters, claims, sent markers, one-time codes and the recipient view.
- Queues: the six delivery lines with their dead-letter queues, `notifications-callbacks`, and the consumed `tenancy-invite-requested`.
- Jobs: `notifications.wake-delivery`, `notifications.reconcile-unread`.
- Events: none produced; the consumed events are listed in the service contract.
- Configuration: `NOTIFICATION_SECRET`, `FRONT_BASE_URL`, `SES_*`, `SMTP_*`, `TWILIO_*`, `FCM_*`, `SNS_TOPIC_ARN`, `NOTIFICATIONS_TX_CONCURRENCY`, `NOTIFICATIONS_MARKETING_CONCURRENCY`, `NOTIFICATIONS_SEND_BUDGET_*`.

## Decisions
- Notifications are requested only by publishing events; the router, projector and core module are not exported.
- The done marker only short-circuits; exactly-once comes from conditional inserts keyed by the deterministic delivery id.
- The unread count is derived data: it can be lost and rebuilt from the inbox, and a dirty set repairs it after a crash.
- Mark-all keeps a watermark on arrival time, so later arrivals stay unread whatever their event time.
- The reset mail has no event consumer: it is handed to the mail port after commit so the raw token sits in no table.
- The reset link carries the token in the URL fragment, so it reaches no server log.

## Known gaps
- Not proven by an automated test (listed in `specs/UNVERIFIED.md`, status `not run`): the load and chaos criteria SC-001 to SC-006 and SC-009, and the browser journeys of W03. R-51, R-52 and R-55 are proven by static gates (`check:table-ownership`, `check:boundaries`, a search for `sequelize.transaction`), not by a test.
- Follower fan-out is a fail-closed stub until S26 exports its following-graph service; the fan-out's idempotence (R-11) has no test of its own.
- Three consumed event names (`launch_events.*`, `seller_insights.*`, `developer_platform.*`) cannot be emitted under the S53 type pattern; the consumer accepts them with the first segment's underscores dropped as well (`launchevents.*`, `sellerinsights.*`, `developerplatform.*`).
