# Gaps: S28 — Notification routing (domain `notifications`)

What the current code gets wrong or lacks versus [`spec.md`](spec.md), the open debt-register rows that touch this capability, and this domain's cross-domain access lines. This is the implementation agent's to-do list. All paths are under `packages/backend/libs/domains/notifications/` unless stated; line numbers are of the draft at the time of writing.

Existing tests: `notifications.e2e-spec.ts` (4 tests: order paid with replay, quiet hours into a scheduled job, one-click unsubscribe, SNS complaint). It injects the tenancy model (`:14`, `:27`), builds the old `OrderPaid` and `AuctionLeaderChanged` payloads (`:81`, `:120`), sleeps for fixed 1.5 s (`:102`, `:145`, `:182`), spies the SMTP provider and renames it SES (`:56`), and has no `401`, validation, cross-user, concurrency, retry, failover, cap, worker, Twilio or fault-injection test. Pure logic has one unit spec (`domain/quiet-hours.spec.ts`).

`pnpm --dir packages/backend check:table-ownership` could not be run while writing this file (the command needs an approval that was not available in this unattended session). Section 3 is built from reading the code; the implementation agent must run the command first, reconcile its `notifications` lines with section 3, and keep `--strict` green for this domain at the end (AS-83).

## 1. Gaps in the code (spec reference → what is wrong or missing → fix)

### Routing and exactly-once (`application/notification-router.service.ts`, `infra/notification-router.projector.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-01 | FR-049, AS-84 | `NotificationRouter.dispatch` (`:66`) is exported (`index.ts:11`) and called by chat (`libs/domains/chat/infra/chat-offline.ts:8,74`), seller-insights (`application/crawler.service.ts:9,44,159`) and developer-platform (`application/webhook-deliverer.service.ts:6,49,136`); their modules import `NotificationsCoreModule` (`chat-offline-worker.module.ts:5`, `crawler.module.ts:10`, `webhooks-core.module.ts:7`). | Remove the export and the module imports; the three producers publish `chat.message_escalated` (S24), `seller_insights.competitor_price_dropped` (S41) and `developer_platform.webhook_endpoint_disabled` (S43); S28 consumes them (catalog rows). Update `chat-sync.e2e-spec.ts:10,108` and `crawler.e2e-spec.ts:15,59`, which spy on `dispatch`, to spy on the emitted events instead. |
| G-02 | FR-001, FR-013, AS-04, AS-05 | The projector subscribes to 3 topics (`notification-router.projector.ts:23`) and maps with `.match` on event classes; no zod validation of payloads, no unsupported-version path, no unmapped-type counter, no dead-letter reason. | One typed mapping per catalog row over the S53 envelope, validated with the `packages/contracts` schemas; dead-letter reasons `invalid_payload`, `unsupported_version`, `render_failed`; counter `notifications_events_ignored_total{reason}`. Subscribe to the topics of every producer in the catalog. Pure mapping in `domain/event-mapping.ts` (AS-13). |
| G-03 | FR-004, AS-04, AS-12 | `dispatch` runs 50 requests in `Promise.all` (`:70`); one thrown render error rejects the batch and the framework retries all of it forever (poison message). | Isolate per request: render, validate, then act; a bad request goes to the dead-letter path with its reason and the rest continue. |
| G-04 | FR-002, FR-003, AS-02, AS-03 | Fast-path "done" marker `notif:done:` written last (`:76,126`) with a 7-day TTL in the fast store; the marker is the only shortcut, but the inbox counter and the cap counter are not idempotent (G-18, G-22). | Keep deterministic ids and the done marker as an optimisation only; make every step idempotent; one e2e per crash point (AS-03). |
| G-05 | FR-005, AS-10 | No version guard: a late `auction.leader_changed` or delivery milestone notifies after the closing event. | Per aggregate and family high-water mark of the event version (7-day memory), compare-and-set; drop lower versions. |
| G-06 | FR-006, AS-11, AS-34 | No maximum age; replays and quiet-hours delays send stale pushes. Occurred-at falls back to `new Date()` (`:82`). | `maxAge` per catalog type; check at consumption and at wake instant; timeline `expired`; inbox kept. |
| G-07 | FR-007, FR-008, AS-06–AS-08 | `if (!recipient) return` (`:75`) silently drops; recipients are loaded one by one (`preferences.service.ts:33`); only `userId` recipients exist (no address recipients, no shop recipients except `billing` via a model query). | Batched R1 calls once per consumed batch (identity directory, tenancy membership), recipient kinds `user | shopOwners | address | followers`, counters for ignored recipients. |
| G-08 | FR-009, AS-01, AS-81 | Money formatted in the projector with a hard-coded `'en-US'` and `'usd'` (`notification-router.projector.ts:40,48,52`); `formatMoney` divides by 100 (`domain/templates.ts:52`), wrong for JPY and KWD. | Render per recipient locale from `…Minor` + `currency` with the currency's own exponent; pure `domain/money.ts`; reject non-integers. |
| G-09 | FR-010, AS-30–AS-32 | Quiet hours use `new Date()` and `Date.now()` (`:114,120`); apply to every priority including mandatory; wake time computed once and never re-checked. | Injected clock; mandatory and phone-verification bypass; wake-time re-check of maximum age, suppression, preference (G-27). |
| G-10 | FR-027, AS-41 | Marketing deliveries of every channel share one queue (`:111`, `domain/types.ts:280-285` `NOTIFICATION_QUEUES.marketing`): a marketing SMS outage blocks marketing push, and marketing concurrency is a flat 5 (`infra/notification-workers.service.ts:50`). | One marketing line per channel with its own dead-letter line and lower concurrency; no cross-channel head-of-line blocking. |
| G-11 | FR-014, AS-09, AS-85 | No secret handling rules: the whole `DeliveryMessage` (including unsubscribe URLs) is logged on failures only by message id, but nothing guarantees tokens stay out of logs, dead letters and the timeline; no reset or invite flow exists. | Redaction and tests (AS-85); consume `identity.password_reset_requested` and `tenancy.invite_requested` as mandatory, inbox-less e-mails; dead-letter without body. |
| G-12 | FR-052, AS-87 | Catalog has 9 types (`domain/catalog.ts:344-445`): no producer for `competitor.price_drop`, `webhooks.endpoint_disabled`, `chat.message`, `marketing.drop_starting`; none for security, shop, order lifecycle, payout, booking, discussions. `chat.message` template uses `{{sender}}` and defaults to e-mail (`:403-411`). | Implement every row of the spec's catalog table; categories `account`, `security`, `orders`, `auctions`, `billing`, `payouts`, `shop`, `bookings`, `chat`, `discussions`, `developers`, `insights`, `marketing` (`domain/catalog.ts:320-321` has 7); maximum ages, recipient rules, mandatory flags; en and uk templates for each. |

### Caps, workers, providers (`application/notification-router.service.ts`, `infra/*`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-13 | FR-025, FR-026, AS-35–AS-39 | `underCap` (`:129-136`) uses a fixed window, increments for every attempt including over the limit, counts again on replay, and has no store-outage behaviour. | Rolling window, atomic admit-or-reject, first decision per delivery id is final, marketing fail-closed on store outage. |
| G-14 | FR-028, AS-42, AS-43 | One bucket `notify.<channel>` (`notification-workers.service.ts:69`), no marketing budget, no fail mode. | Separate `.marketing` buckets (20 %), transactional fail-open, marketing fail-closed with a 60 s delay; counter. |
| G-15 | FR-031, AS-47, AS-48 | Transient failure rethrows (`:89`); redelivery after a fixed 60 s visibility timeout (`:45`); dead letter only through the queue's max receive count; no `failed/exhausted` status. | Exponential backoff with full jitter via a pure `domain/backoff.ts`, 5 attempts, explicit dead-letter move with timeline status and counter. |
| G-16 | FR-032, FR-033, AS-49–AS-52 | The sent marker is checked non-atomically (`:59`) and written after the send (`:79`): two concurrent copies both send. Suppression is checked (`:63`) but not the user's current preference or the maximum age. No payload validation of queue messages. | Atomic claim per delivery id; validate the message; send-time preference and age checks; `skipped` and `expired` statuses. |
| G-17 | FR-029, FR-034, AS-44, AS-45, AS-53, AS-54 | `ChannelSender` has breakers and a 10 s timeout (`infra/providers/channel-sender.ts:25-37`) but no failover flag in the timeline, no breaker metric; `notification-providers.ts:31,41` silently choose log providers in every environment; the unsubscribe secret falls back to the JWT secret (`notification-router.service.ts:63`, `api/notifications.controller.ts:132`). | Record `failover`; export `notifications_provider_circuit_state`; production config schema fails startup without credentials and without a dedicated `notification_secret`; stand-ins reported `provider: "log"`, never `delivered`. |

### Inbox (`application/inbox.service.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-18 | FR-038, AS-02, AS-61, AS-62 | Counter increment is guarded by a separate NX marker (`:55`) after an unconditional insert (`:51-54`): a crash between them or a lost marker miscounts; the counter is only read from the fast store (`:101`), never rebuilt. | Once-only insert whose result says "new"; increment only for new items; rebuild from the inbox when the counter is absent (bounded 1,000); 5-minute reconciliation job (S49). |
| G-19 | FR-039, AS-60 | Mark-all stores `Date.now()` (`:124`) and compares it with the event-time id (`:86`, `:111`), so an item whose event is older than the mark-all moment shows read while the counter counts it. | Store arrival time on the row (first insert) and compare the watermark with arrival time. |
| G-20 | FR-037, AS-56 | The cursor is a raw `<bucket>:<pageState>` string parsed without validation (`:65`), usable across users; list `limit` is clamped in the controller (`api/notifications.controller.ts:51`); month walk constant `MONTHS_KEPT = 6` (`:22`) disagrees with the 180-day TTL. | Signed, user-bound opaque cursor, `400 invalid_cursor`, `400` for out-of-range limit; retention by age (180 days) rather than months. |
| G-21 | FR-039, AS-59 | `TimeUuid.fromString(raw)` on any string (`:110`) → `500` on garbage; `ids` and `all` combined silently prefer `all`; `BadRequestException('ids or all')` (`controller:68`) has no problem code; DTO `ids` is `string[]` with no format check. | zod schema in `packages/contracts` (`markReadRequestSchema`): exactly one of `ids` (1–100 UUID-shaped ids) or `all: true`; foreign and unknown ids ignored. |
| G-22 | FR-040, AS-63 | `realtime.publish` is awaited inline (`:57-59`); a hub failure fails the add and the event retries. | Best-effort publish after the stored+counted step; counter `notifications_realtime_publish_failed_total`. |
| G-23 | FR-041, AS-65, AS-66 | No `inapp` opt-out handling beyond the channel list; no length limits; link is whatever the catalog function builds from unvalidated data. | Validated identifiers, relative links only, length limits, per-category in-app opt-out. |

### Preferences, settings, devices, unsubscribe (`application/preferences.service.ts`, `api/notifications.controller.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-24 | FR-015, AS-14 | `defaultFor` (`preferences.service.ts:137-139`): marketing push on by default; no `mandatoryChannels`; `channelsFor` (`:347-361`) mixes defaults, opt-in and presence of contact data. | Defaults per the spec (marketing external off, SMS off, inapp on); `mandatoryChannels` in the response; response DTOs and `packages/contracts` schemas. |
| G-25 | FR-016, FR-018, AS-18–AS-23 | `phone` stored unverified (`controller:30` TODO; `updateSettings` `:76-101`); no OTP; quiet start and end may be set separately (`:91-92` merge) so quiet hours silently never apply; equal values accepted; time zone validated in the controller only (`:88`). | Phone verification endpoints, masked phone, `phoneVerified`; `422 phone_not_verified`, `quiet_hours_incomplete`, `quiet_hours_invalid`; validation in schemas; `NotificationSettings.phoneVerifiedAt` migration (expand/contract). |
| G-26 | FR-019, AS-19 | Recipient view cached 5 min with SWR and an in-process copy (`preferences.service.ts:33`, `l1: 'hot'`), so an opt-out may keep applying the old value in other processes. | Shared store only, invalidate on write, no per-process copy for this data. |
| G-27 | FR-024, FR-033, AS-52 | No preference check after queuing. | Re-check at send time (see G-16). |
| G-28 | FR-020, AS-28, AS-29 | `DELETE /devices/:token` (`controller:101-105`) deletes any user's token (no principal in the predicate); the token travels in the URL; no device cap; `removeDevices` (`preferences.service.ts:113`) trusts callers. | Device ids, owner-scoped delete (`404` otherwise), `GET /devices`, cap 10, `201|200` responses. |
| G-29 | FR-036, AS-25–AS-27 | Unsubscribe endpoints are anonymous with no rate limit and generic `BadRequestException`; the token MAC key falls back to the JWT secret (G-17); a mandatory-type mail correctly has no link (`notification-router.service.ts:109`) but the header contract is untested. | `notifications.unsubscribe.ip` policy, `invalid_unsubscribe_token` code, dedicated key, header presence test through the provider spy. |
| G-30 | FR-050 | All routes use class-validator DTOs, no `packages/contracts` schemas, ad-hoc error strings; no rate-limit policies. | Contract schemas for every request and response; stable problem codes; policies `notifications.read.user`, `notifications.write.user`, `notifications.phone-code.user`, `notifications.phone-verify.user`, `notifications.unsubscribe.ip`, `notifications.webhook.ip`. |

### Callbacks, suppression, timeline (`api/notification-webhooks.controller.ts`, `api/sns-verifier.ts`, `application/suppression.service.ts`, `infra/delivery-log.service.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-31 | FR-043, AS-69, AS-70 | The SES handler applies effects inline before answering (`controller:37-70`); replay window 1 hour (`sns-verifier.ts:24`); `JSON.parse(message.Message)` unguarded (`controller:56`) → `500` on a bad inner message; no dedupe on `MessageId`. | Verify, durably accept, answer `2xx`, apply in a worker keyed by the provider event id; 5-minute tolerance; `400` for non-JSON at both levels. |
| G-32 | FR-043, AS-73 | `fetch(message.SubscribeURL)` (`controller:49-52`) relies on the signature check alone. | Additionally require HTTPS and the SNS host pattern; `400` and no request otherwise. |
| G-33 | FR-045, AS-71, AS-72 | `updateByProviderId` overwrites status unconditionally (`delivery-log.service.ts:31-37`), so a late `delivered` can overwrite `complained`; an unknown provider id is dropped (`:33`) instead of retried; `DeliveryStatus` lacks `skipped` and `expired` (`:4`). | Pure precedence rule `domain/delivery-status.ts`, conditional update, 10-minute retry for early callbacks, new statuses. |
| G-34 | FR-043, AS-74, AS-75 | Twilio handler (`controller:77-92`): no dedupe of `(MessageSid, MessageStatus)`; STOP number suppressed as received, not normalized; an unconfigured token answers `401` (acceptable) but nothing is asserted. | Dedupe, E.164 normalization, tests. |
| G-35 | FR-042, AS-76 | Suppression check is cached with a negative TTL of 10 minutes (`suppression.service.ts:25-27`); `suppress` invalidates (`:43`), but only its own Redis key and addresses are not trimmed (only lower-cased); Postgres access through the raw connection (`:17,26,39`). | Normalize (trim, lowercase, E.164), immediate effect, repository port in `domain/` and adapter in `infra/` (G-39). |
| G-36 | FR-044, AS-67, AS-77 | A complaint finds the user through the delivery row (`controller:61-67`) and ignores the case where the row is missing without counting it. | Suppress by address regardless; counters. |

### Boundaries and operations

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-37 | FR-048, AS-83 | See section 3. | R1 for users and memberships. |
| G-38 | FR-049, AS-84 | `index.ts:8-12` exports `formatMoney`, `NotificationRouter`, `NotificationRouterProjector`, `NotificationsCoreModule`; `apps/projector/src/projector.module.ts:12,52` imports the projector class and the core module directly. | Export only `NotificationsModule`, `NotificationsWorkerModule`, `NotificationsProjectorModule` and contract types; apps import those. |
| G-39 | I.2 (D-6) | `application/notification-router.service.ts:12` imports `../infra/delivery-log.service`; `api/notification-webhooks.controller.ts:7` imports the same infra class; application services take `Sequelize`, Redis and Scylla clients directly (`preferences.service.ts:2-3,26`, `suppression.service.ts:2-3,17`, `inbox.service.ts:4,39`). | Repository and store ports with injection tokens in `domain/` (preferences, suppression, devices, inbox, delivery timeline, counters, caps), adapters in `infra/`. |
| G-40 | FR-051, AS-85, AS-86 | No metrics; structured-log redaction untested. | Metrics of AS-86; log-capture e2e. |
| G-41 | UI | `packages/web/components/notifications-popover.tsx:23-35` keeps local state fed by `useEventStream(['notifications'], ['notification'])` — a topic the backend does not publish (it publishes on `user:<id>`), never loads the inbox, never marks read; no preferences or unsubscribe screen. | W03: use the contract (`GET /notifications`, `unread-count`, `read`, live `notification` on `user:<id>`), preferences matrix and unsubscribe page; the journeys in `test-plan.md`. |
| G-42 | VII.2 | The existing spec constructs the old event payloads and uses fixed sleeps (see top). | Rewrite per `test-plan.md`. |

## 2. Debt-register rows that name `notifications` (or S28) and what pays them

| Row | Rule | What | Replacement / action |
|---|---|---|---|
| D-6 | I.2 | `api/` and `application/` import `infra/` directly (see G-39). Counts for this domain: 2 explicit `infra/` imports, 4 services holding stores directly. | Repository ports in `domain/`, adapters in `infra/`; paid by this capability. |
| D-7 | IX.4 | Other domains' models: the projector injects the tenancy `ShopMembership` model (`infra/notification-router.projector.ts:3,27,59`) and the e2e spec registers it (`notifications.e2e-spec.ts:14,27`). | **R1** tenancy `MembershipQueryService.getMembersByShopIds` (S03); remove the model import and the e2e registration. |
| D-8 | X.4 | The barrel exports infrastructure internals (`NotificationRouterProjector`, `NotificationsCoreModule`, `NotificationRouter`) because apps and three other domains wire them directly (`index.ts:8-12`, `apps/projector/src/projector.module.ts:12,52`, G-01). | Export only the three Nest modules; apps import `NotificationsProjectorModule`; other domains emit events (**R3**). |
| D-12 | IX.4 | Raw SQL on a table owned by another domain: `preferences.service.ts:128` `FROM "User" u LEFT JOIN "NotificationSettings" s` (also a cross-owner JOIN). The domain map lists `User` and `ShopMembership` readers including notifications (domain-map §3). | **R1** identity `UserDirectoryService.getUsersByIds` for the e-mail address (S01); recipient view built from `NotificationSettings`, `NotificationPreference`, `PushDevice` (own tables) joined in code, never in SQL. |

Not named but relevant: D-3 (topic registry) is resolved; this capability registers no topics and only publishes on `user:<userId>`. D-14 and D-15 do not touch this domain.

## 3. `check:table-ownership` lines for `notifications` (read from the code; run the command to confirm)

| Kind | Where | What | IX.7 mechanism that replaces it |
|---|---|---|---|
| SQL | `application/preferences.service.ts:128` | `"User"` (JOIN with `"NotificationSettings"`) | R1 `UserDirectoryService.getUsersByIds` (S01) |
| MODEL | `infra/notification-router.projector.ts:3,27` | `ShopMembershipModel` injected (`@InjectModel`) and `findAll` at `:59` | R1 `MembershipQueryService.getMembersByShopIds` (S03) |
| MODEL (test) | `notifications.e2e-spec.ts:14,27` | `SequelizeModule.forFeature([ShopMembership])` | Seed through tenancy's exported service and fixtures |
| SQL (test) | `notifications.e2e-spec.ts:123` | `FROM "Job"` (jobs infrastructure table) | Assert through the job scheduler's exported inspection helper (S49) or the scheduler's fixture, not raw SQL |
| own | `preferences.service.ts:69,78,106,115,126,127`, `suppression.service.ts:26,39` | `NotificationPreference`, `NotificationSettings`, `PushDevice`, `NotificationSuppression` | owned by `domain:notifications` in `db/ownership.ts:132-135`; keep |

Cross-domain event reads (`@app/domains/orders`, `auctions`, `billing` event classes imported at `infra/notification-router.projector.ts:6-8`) are event contracts, not table access (X.4 allows event contracts); they are replaced by the `packages/contracts` event schemas of each producer (R3), so the domain no longer depends on those domains' entry points at all.

## 4. Pattern-map rows to move (`docs/architecture/pattern-map.md`)

P0104 (quiet hours), P0419 (provider status callbacks), P0601 (router, queue versus log), P0618 (per-channel queues) are `implemented`; this spec moves them to `spec'd`, and the implementation loop moves them to `verified` when AS-30–AS-34, AS-67–AS-75, AS-01–AS-05 and AS-40–AS-41 pass.

## 5. Order of work

1. Run `check:table-ownership` and `check:boundaries`; record the baseline.
2. Contracts: event schemas the consumer needs, HTTP schemas, policies in S50's registry, config schema (G-17, G-30). Coordinate with S10 (`userId` on `order.fulfilment_changed`), S26 (follower page), S41 and S43 (new events), S24 (already emits).
3. Domain layer: ports, `event-mapping`, `quiet-hours` (tests), `backoff`, `delivery-status`, `templates`/`money` (G-08, G-39, AS-13, AS-33, AS-48, AS-71, AS-78–AS-82).
4. Recipient resolution through R1 and the removal of the model and SQL access (G-07, D-7, D-12).
5. Router: isolation, idempotence, version guard, expiry, caps, quiet hours (G-02–G-06, G-09, G-13); inbox (G-18–G-23).
6. Worker: lines, budgets, retries, failover, send-time checks (G-10, G-14–G-17).
7. HTTP surface: preferences, settings, phone verification, devices, unsubscribe (G-24–G-30).
8. Callbacks and suppression (G-31–G-36).
9. Barrel, modules, remove `NotificationRouter` callers in chat, seller-insights, developer-platform (G-01, G-38); update their specs.
10. Observability (G-40); rewrite the e2e specs per `test-plan.md` (G-42); W03 changes (G-41); record the green run (VII.9).
