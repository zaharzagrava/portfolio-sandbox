# Implementation Plan: S28 — Notification routing (preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression) (domain `notifications`)

**Branch**: `S28-notifications` (working branch `sdd/auto`) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md`. Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/events.md](contracts/events.md), [contracts/services.md](contracts/services.md), [quickstart.md](quickstart.md).

## Summary

`notifications` already has a catalog of 9 types, a router service called directly by three other domains, an SQS worker with per-channel breakers, an inbox on the wide-column store, preferences with a raw `"User"` join, and one 4-test e2e spec that injects the tenancy model and sleeps. S01, S02, S03, S10, S13, S14, S49, S50, S52, S53 and S54 are built; most other producers (S04, S15, S17, S20–S22, S24–S26, S41, S43) are not, so their events are consumed through consumer-side schemas (research R-3). The plan, in the order of [gaps.md](gaps.md) section 5:

- **Pure rules in `domain/`**: event mapping, quiet hours (extended, property test), backoff, delivery-status precedence, templates, money, catalog (13 categories, ~45 types, en + uk), unsubscribe token, cursor signing, cap-window arithmetic, ports; table-driven specs plus `fast-check`.
- **Intake**: one consumer per source family over the S53 framework; zod validation, per-request isolation, dead-letter reasons, ignored-type counter, version guard, maximum age; recipients resolved in batches through `UserDirectoryService` and `MembershipQueryService` (R1) and a follower-audience port (R-5).
- **Exactly-once routing**: deterministic ids, `IF NOT EXISTS` inbox insert that says "new", counter increment only for new items with a dirty-set repair, best-effort realtime, atomic rolling cap, final per-delivery decisions, markers only as shortcuts.
- **Lines and workers**: six lines (3 channels × transactional/marketing) each with a DLQ and its own concurrency; atomic send claim, send-time checks, S50 send budgets with fail modes, provider chain with failover flag and breaker metric, backoff with full jitter and an explicit dead-letter move; quiet-hours delay split between SQS delay and an S49 job.
- **HTTP surface**: contract schemas for every route, preferences with `mandatoryChannels`, settings validation, OTP phone verification, devices by id, signed user-bound cursors, mark-read validation, unsubscribe on a dedicated key, S50 policies.
- **Callbacks and suppression**: verify → durable accept → worker; forward-only status; early-callback retry; normalized suppression with immediate effect; SNS host pinning; Twilio dedupe.
- **Boundaries**: the `"User"` join and `ShopMembership` model disappear; repository and store ports replace the 2 explicit `infra/` imports and 4 store-holding services; the barrel shrinks; chat, seller-insights and developer-platform stop calling the router; `apps/projector` imports the projector module.
- **Tests and ops**: the 8 e2e files and 6 unit specs of [test-plan.md](test-plan.md) replace the old spec; web changes for W03 (bell, popover, preferences, unsubscribe page) at the end.

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

| From | Requirement | Where planned / proven |
|---|---|---|
| S01 | consume `identity.user_registered`, `registration_duplicate_attempted`, `password_changed`; the single-consumer `password_reset_requested` (never log `resetToken`); replace the `"User"` join in `preferences.service.ts` with `getUsersByIds` | WP-3/WP-4: three events mapped; the `"User"` join is deleted (`RecipientDirectory`); AS-06/AS-83. `password_reset_requested`: superseded, see next row |
| S01 / W01 | `password_reset_requested` is **not** emitted; reset link goes through `PASSWORD_RESET_MAILER`, link `<front>/reset-password#token=<token>`, `DeliveryMessage.type` widened by `'auth.password_reset'`, dev mailbox `GET /api/dev/mailbox` | WP-3: no consumer; `TransactionalMailService` reuses the catalog type + templates + redaction; AS-09 asserted through the port and the dev mailbox (existing `dev-mailbox.e2e-spec.ts` kept and extended); research R-1 |
| S01 | stop reading `User` via `UserModel` / raw SQL (`UserDirectoryService`); `KNOWN_FOREIGN_ROWS` (AS-81 ratchet) to 0 | WP-4: the single `notifications` row (`preferences.service.ts:128`) disappears. The constant itself lives in S01's spec (`identity/ownership-gates.e2e-spec.ts`); sibling bullet for S01 if it still lists `notifications` after this work |
| S02 | six new events; `federated_identity_linked` with `passwordInvalidated: true` is the "your password was removed" mail | WP-3: catalog rows `security.mfa_*`, `security.recovery_*`, `security.sign_in_method_*`; text variants tested by AS-87 and `templates.spec.ts` |
| S03 | replace `ShopModel`, `ShopMembershipModel`, `MembershipService`, raw tenancy SQL with `ShopAccessService` / `ShopQueryService` / `MembershipQueryService`; retest `payouts.read`, `sso.manage`, `403 shop_suspended` / `409 shop_offboarding` | WP-4: only `MembershipQueryService.getMembersByShopIds(ids, ['OWNER'])`; the model import and the e2e `forFeature([ShopMembership])` are removed. The notifications routes use no `ShopScoped` permission, so the suspended/offboarding answers and the two permission changes are not reachable here: noted in quickstart as "checked, n/a" |
| S03 | `tenancy.invite_requested` as outbox task on queue `tenancy-invite-requested` (body fixed); link `<front>/invites/<token>`; offboarding started/cancelled/deleted events to owners | WP-3: queue consumer + `shop.invite`; `shop_offboarding_started|cancelled` mapped; `shop_deleted` consumed and ignored (`not_mapped`; owners are no longer resolvable after the purge per S03); AS-08, AS-09 |
| S10 | event rename and new events; fix `notification-router.projector.ts` and the e2e payloads | WP-3/WP-10: `total→totalMinor`, `unitPriceMinor`, `paymentRef`, `shopOrders`, `orderVersion`, `previousStatus`, `order.refunded`, `order.fulfilment_changed` mapped; other importers (`experimentation`, `developer-platform`, `discovery`, `seller-insights`, `payments`) are other capabilities' lines: listed as sibling bullets, not edited |
| S13 | consumers of `payments.events` use `paymentEventSchemas` | WP-3: `payment.failed` validated with it |
| S14 | optional: `ledger.reconciliation_*` alerts | **Not consumed** (no recipient directory for finance staff, spec Assumptions); recorded in research R-18 |
| S49 | `declareJobType` + payload contract; `JobsService.cancel` discriminated; catch `InvalidScheduleError` | WP-6: `notifications.wake-delivery`, `notifications.reconcile-unread`; the `UnknownJobTypeError` path covered by AS-31/AS-62 |
| S50 | policies in the domain with `definePolicies` + `forFeature`; structured headers; `503 rate_limiter_unavailable` / `422 rate_limit_cost_exceeded` | WP-7: six HTTP policies + send budgets `notify.<channel>[.marketing]`; [contracts/http.md](contracts/http.md) documents the answers; AS-16/AS-23/AS-26/AS-42/AS-43 |
| S52 | `l1: 'never'` for preference, suppression, site records | WP-4: recipient view and suppression read use it; the old `l1: 'hot'` is removed (G-26); AS-19 asserts cross-process effect |
| W03 | the notification event has no `unreadCount`; preferences screen has no owner | WP-12: popover reloads the count on focus/reconnect; the preferences screen and unsubscribe page are built in W03's `packages/web` area as G-41 states |
| rule 0 | living spec begins with the page | WP-0 creates `docs/spec/capabilities/S28-notifications.md` (rules, behaviors, `[proof:]` / `[code:]` clauses, scope globs for the domain and `packages/contracts/src/notifications/**`) **before** code; keeps `python3 scripts/livespec/check.py` green; no `*.reviewed.json`. The pages of S01 (reset mail) and W03 mention notifications; if a signed statement changes, say so under `## Spec changes` in gaps.md |
| rule 1 | sibling bullets | recorded in gaps.md `## Sibling-spec follow-ups` (done with this plan) |
| rule 2 | unverified criteria | quickstart "Ops artifacts" and `specs/UNVERIFIED.md` rows (done with this plan) |
| rule 3 | no checkout/restore/reset/stash/clean | all undo is by hand edit |
| rule 4 | `TransactionRunner.run` / `@Transactional` | baseline in `.tx.baseline` is 0 and stays 0; the new device cap eviction uses `TransactionRunner.run` |
| gaps.md | G-01…G-42, D-6, D-7, D-8, D-12, section 3 lines, section 4 pattern rows | "Gap coverage" below |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend` domain `notifications`; schemas in `packages/contracts`; Next.js in `packages/web` for W03.

**Primary Dependencies** (all present): `@nestjs/sequelize`, `cassandra-driver` via `@app/infrastructure/cassandra`, Redis client via `@app/infrastructure/redis`, SQS via `@app/infrastructure/sqs`, S53 `Projector` / consumer framework, S49 `JobsModule`, S50 `RateLimitModule.forFeature`, S52 cache, S51 `RealtimePublisher`, S54 `TransactionRunner`, clock, config, metrics, problem+json filter; `fast-check` (devDependency, present). `UserDirectoryService` (`@app/domains/identity`), `MembershipQueryService` (`@app/domains/tenancy`). `FollowQueryService` (community) **does not exist yet** (R-5).

**Storage**: PostgreSQL (`NotificationPreference`, `NotificationSettings` +`phoneVerifiedAt`, `NotificationSuppression`, `PushDevice` +`tokenHash`); wide-column store (`notification_inbox` +`arrivedAt`, `notification_inbox_state`, `notification_delivery`, `notification_delivery_by_provider`); Redis (dedupe, caps, counters, claims, codes). No new Postgres table.

**Testing**: Jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` — the 8 files of [test-plan.md](test-plan.md) + 6 unit specs + the extended `quiet-hours.spec.ts`; static gates `tsc --noEmit`, ESLint, `check:boundaries`, `check:module-graph`, `check:table-ownership --strict`, `check:model-registry`, `check:no-wallclock`; Playwright journeys in W03 (happy path only).

**Target Platform**: Linux containers: `apps/core` hosts `NotificationsModule` (HTTP, callback intake); `apps/worker` hosts `NotificationsWorkerModule`; `apps/projector` hosts `NotificationsProjectorModule`. **No new deployable** (I.6).

**Project Type**: web-service (backend domain) + contracts package + web client changes.

**Performance Goals**: inbox visible ≤ 2 s p99 at 115 ev/s (2,000 peak); inbox list p99 < 150 ms, unread < 50 ms at 30,000 rps (counter is one Redis read); transactional send within 1 s of a marketing burst (own queues, own concurrency). These are load claims → Ops artifacts.

**Constraints**: every outbound call has a timeout (providers 10 s, directory/membership batch 2 s, Redis 200 ms, wide-column 1 s, realtime publish 500 ms); retry in exactly one layer (the delivery line; provider chain failover is not a retry); no network I/O inside a DB transaction (the only transaction is device registration, two statements); no secret in logs, timeline, metrics or dead letters.

**Scale/Scope**: 16 HTTP routes, 0 produced events, 21 consumed families (~45 catalog types), 7 queues (+DLQs), 2 job types, 6 HTTP policies + 6 send budgets, 87 acceptance scenarios (8 e2e files + 6 unit specs), 4 owned tables.

### Pool arithmetic and `statement_timeout` (III.12)

- No new pool; the shared S54 pool (P = 10 per instance) applies. Routing reads preferences/settings/devices with three `IN (…)` queries per consumed batch (not per recipient) and holds a connection for each ≤ 20 ms; the worker reads one preference row per send. The device registration transaction is two statements (< 10 ms). Worker concurrency (10 transactional + 3 marketing per line × 3 lines = 39 in-flight sends) exceeds P, so the Postgres read in the send path goes through the S52 shared recipient-view cache first (hit rate expected > 95 %) and falls back to a pooled query that queues on the pool, never opens more connections. Instances × P stays under the database limit stated by S54; no `notifications` change raises it.
- The unread reconciliation reads the wide-column store, not Postgres.

## Constitution Check

*GATE: passes before Phase 0 and re-checked after Phase 1 design (below).* Each line is a "Pull Request Compliance Gate".

| # | Gate | Status | How |
|---|---|---|---|
| 1 | Boundaries (I.1–I.6, matrix, no `forwardRef`, no `Scope.REQUEST`) | **Pass after WP-1/WP-9** | all stores behind `domain/ports.ts` tokens; `application/` imports no `infra/` (today 2 explicit imports + 4 store-holding services, D-6); `domain/` has no `Date`/Nest/Redis; no new app |
| 2 | Controllers (II.1), no HTTP `try/catch` | **Pass** | controllers: zod-validated DTO → one service call → response DTO; domain errors are `AppError`s with codes; the ad-hoc `BadRequestException`s are removed |
| 3 | Data access: principal in predicate, no I/O in transactions, store-enforced invariants, integer money, keyset pagination | **Pass** | device delete `WHERE id AND userId`; inbox partition key is the user; mark-read and insert use LWT; caps and version guard are atomic scripts; money only as `…Minor` + `currency`; cursor keyset `(eventTime, id)` |
| 4 | Migrations expand/contract with `lock_timeout` | **Pass** | `phoneVerifiedAt`, `tokenHash`, indexes `CONCURRENTLY`, `NOT VALID` check then validate; no contract step ([data-model.md](data-model.md)) |
| 5 | Messaging: idempotent zod-validated consumers, timeouts | **Pass** | mechanism documented in research R-6 (deterministic ids + natural upserts + shortcut marker); S28 publishes nothing so no outbox is needed; backoff + DLQ per line |
| 6 | Contracts: DTOs, `packages/contracts`, problem+json, `Idempotency-Key` | **Pass** | schemas for every route; no route creates an order/payment/booking/bid/ledger movement so V.6 does not apply; idempotence of PUTs and mark-read is natural |
| 7 | Web | **Pass after WP-12** | W03 changes use `lib/api/*` with contract schemas, TanStack Query keys from `lib/query-keys.ts`, server data not copied into `useState`; unsubscribe page is a Server Component with a client button |
| 8 | Tests: VII.2/VII.3 per endpoint, VII.4 per consumer, test plan updated, green run recorded | **Pass (proven by WP-11)** | [test-plan.md](test-plan.md) 87 rows → 8 e2e files + 6 unit specs; green run recorded by WP-11 |
| 9 | Operational: no secrets/PII in logs, jobs single-run and idempotent, graceful shutdown | **Pass** | AS-85 log-capture; `fleetConcurrency: 1` for the periodic job; workers stop polling on shutdown (S54 hooks) |
| 10 | Database isolation (IX) | **Pass after WP-4** | `check:table-ownership --strict` findings for `notifications` 2 → 0 (the `"User"` SQL and the `ShopMembership` model); test rows removed (injected model, raw `"Job"` SQL replaced by the scheduler's inspection helper); no new table; no cross-owner JOIN/FK/association |
| 11 | Monorepo boundaries (X) | **Pass after WP-9** | barrel shrinks to three modules + `TransactionalMailModule`; `apps/projector` imports the module; chat, seller-insights, developer-platform drop the router import; imports only through entry points |

**Post-design re-check (after Phase 1)**: unchanged; the one new dependency (`FollowQueryService`) is behind a port with a fail-closed adapter, so gate 1 and gate 10 hold even before S26 ships. The reset-mail deviation (R-1) removes a consumer rather than adding one.

## Complexity Tracking

| ID | Rule | Why it cannot be met now | Simpler alternative rejected | Removal date |
|---|---|---|---|---|
| CT-1 | IV.1 / X.4 (no importing other domains' internals) vs three edits in chat, seller-insights, developer-platform | The router call must be removed in the producers' own files, otherwise the barrel cannot shrink (G-01) | Leave the export and mark it deprecated: keeps D-8 open and the three modules coupled | 2026-11-30 (when S24/S41/S43 specs are built; edits here are minimal and listed as sibling bullets) |
| CT-2 | FR-007 (marketing audience from S26's `FollowQueryService`) | The service does not exist | Reading follow tables: forbidden (IX.4) | when S26 ships (stub adapter then replaced); tracked as sibling bullet |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S28-notifications/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ http.md  events.md  services.md
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/    # inputs (gaps.md gains "## Sibling-spec follow-ups" and "## Spec changes")
└── tasks.md                                                     # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
docs/spec/capabilities/S28-notifications.md           # WP-0, before code (living spec page; no .reviewed.json)
specs/UNVERIFIED.md                                    # + S28 rows (done with this plan)

packages/contracts/src/notifications/
├── http.ts              # notificationPage/Item, unreadCount, markReadRequest, preferences, updatePreference/Settings, phoneVerify, device, registerDevice, unsubscribe schemas
├── consumed-events.ts   # consumer-side schemas for producers without a contract file (R-3)
├── realtime.ts          # notificationRealtimeEventSchema
└── index.ts             # re-export (exists; extended)

packages/backend/libs/domains/notifications/
├── api/        notifications.controller.ts (inbox + unread + read) · preferences.controller.ts · devices.controller.ts · unsubscribe.controller.ts · notification-webhooks.controller.ts (intake only) · sns-verifier.ts · dev-mailbox.controller.ts · notifications.dto.ts (zod pipes from contracts)
├── application/ event-routing.service.ts · notification-router.service.ts (idempotent steps) · recipient-view.service.ts · inbox.service.ts · preferences.service.ts · settings.service.ts (phone OTP) · device.service.ts · unsubscribe.service.ts · suppression.service.ts · delivery-worker.service.ts · callback-intake.service.ts · callback-worker.service.ts · unread-reconcile.service.ts · transactional-mail.service.ts (kept) · notification-delivery.job-types.ts (declared)
├── domain/     catalog.ts · event-mapping.ts · quiet-hours.ts · backoff.ts · delivery-status.ts · templates.ts · money.ts · cap-window.ts · unsubscribe-token.ts · cursor.ts · errors.ts · metrics.ts · ports.ts · types.ts · provider-ports.ts · *.spec.ts (six new + quiet-hours extended)
├── infra/      consumers/ (one per source family, topics config) · invite.consumer.ts · models/ (4 existing, +columns) · repositories/ (preference, settings, device, suppression) · inbox.store.ts · delivery-timeline.store.ts · redis-stores.ts (counters, caps, dedupe, version, claim, otp) · recipient-directory.adapter.ts · follower-audience.adapter.ts · realtime.adapter.ts · delivery-lines.ts (queues) · notification-workers.service.ts (wired to the service) · providers/ (existing + failover flag, breaker gauge) · notification-providers.ts (explicit stand-ins) · notifications.config.ts
├── notifications.module.ts · notifications-worker.module.ts · notifications-projector.module.ts (new) · notifications-core.module.ts (internal, no longer exported)
├── rate-limit-policies.ts · index.ts (three modules + contract types)
└── notifications-{routing,preferences,quiet-caps,delivery,inbox,callbacks,catalog,observability}.e2e-spec.ts   # replace notifications.e2e-spec.ts (deleted)

packages/backend/migrations/    # phoneVerifiedAt · tokenHash + indexes · quiet-hours check (NOT VALID, then VALIDATE) · wide-column DDL: arrivedAt, notification_inbox_state, delivery_by_provider
packages/backend/apps/projector/src/projector.module.ts            # imports NotificationsProjectorModule
packages/backend/libs/domains/{chat,seller-insights,developer-platform}/…   # router call + module import removed; events asserted in their specs (CT-1)
packages/web/{components/notifications-popover.tsx, app/…/settings/notifications, app/unsubscribe, lib/api/notifications.ts, lib/query-keys.ts, e2e/notifications.spec.ts}   # WP-12
scripts/load-tests/notifications-{burst,inbox}.test.js             # Ops artifacts, not run in CI
```

**Structure Decision**: web application layout already used by the repository (backend domain under `libs/domains/notifications`, shared schemas under `packages/contracts`, UI under `packages/web`). No new package, no new app.

## Work packages (ordered; each ends with the narrowest test that proves it)

| WP | Content | Gaps / ASes | Proof |
|---|---|---|---|
| WP-0 | Run `pnpm --dir packages/backend check:table-ownership` and `check:boundaries`, record the baselines in `quickstart.md` (the gaps.md file could not run them); create the living-spec page `S28-notifications.md`; `python3 scripts/livespec/check.py` | D-6..D-12 baseline | check outputs |
| WP-1 | Contracts (`http.ts`, `consumed-events.ts`, `realtime.ts`), policies (`definePolicies`), config schema, pure `domain/` (ports, catalog skeleton, backoff, delivery-status, money, templates, cap-window, cursor, unsubscribe token, event-mapping, quiet-hours extension), six unit specs | G-08, G-30, AS-13/33/48/71/78–82/81 | `test-spec.sh domain` unit specs |
| WP-2 | Migrations and wide-column DDL; model/column changes; repository and store adapters behind ports; remove direct `Sequelize`/Redis/Cassandra use from `application/` | G-39, D-6, G-18 (insert), G-19 | `check:model-registry`, a repository smoke inside WP-4 specs |
| WP-3 | Catalog of all rows (en + uk), `NotificationsProjectorModule`, one consumer per source family + invite queue consumer, mapping with zod, dead-letter reasons, ignored counter, per-request isolation, version guard, max age; reset mail through the mailer reusing the catalog | G-02, G-03, G-05, G-06, G-11, G-12, AS-04/05/09/10/11/12/87 | `notifications-routing`, `notifications-catalog` |
| WP-4 | Recipient resolution (R1 batched), recipient view cache (`l1:'never'`), remove `"User"` SQL and `ShopMembership` model, follower-audience port | G-07, G-26, D-7, D-12, G-37, AS-06/07/08/83 | `notifications-routing` + `check:table-ownership --strict` |
| WP-5 | Router steps: inbox new-only, counter + dirty set, realtime best effort, deterministic ids, caps (rolling, atomic, final), quiet hours (injected clock, mandatory bypass), line enqueue, delayed split | G-04, G-09, G-13, G-18, G-22, G-23, AS-01–03/30–32/34–39 | `notifications-routing`, `notifications-quiet-caps` |
| WP-6 | Workers and lines: six queues + DLQs, concurrency, atomic claim, send-time checks, budgets with fail modes, provider chain (failover flag, gauge), backoff + explicit DLQ, production config failure, wake job + reconcile job (`declareJobType`) | G-10, G-14–G-17, G-27, AS-40–54, AS-31, AS-62 | `notifications-delivery` |
| WP-7 | HTTP surface: preferences/settings/phone OTP, devices, unsubscribe, inbox endpoints (signed cursor, mark-read validation, arrival-time watermark, retention), S50 policies and headers | G-19–G-21, G-24, G-25, G-28–G-30, AS-14–29, AS-55–66 | `notifications-preferences`, `notifications-inbox` |
| WP-8 | Callbacks and suppression: verify → accept → worker, forward-only status, early-callback retry, SNS host pinning, Twilio dedupe, normalization, complaint without delivery row | G-31–G-36, AS-67–77 | `notifications-callbacks` |
| WP-9 | Barrel and modules; `apps/projector`; remove the router from chat, seller-insights, developer-platform and update their specs; observability (metrics, log redaction) | G-01, G-38, G-40, D-8, CT-1, AS-84–86 | `check:boundaries`, `check:module-graph`, `notifications-observability`, the three producers' specs |
| WP-10 | Rewrite/delete `notifications.e2e-spec.ts` (4 tests move to AS-01/AS-02, AS-30/31, AS-25, AS-67); update `dev-mailbox.e2e-spec.ts`; fix payloads in other importers' specs **only if** they import notifications (they do not: sibling bullets) | G-42 | all 8 files |
| WP-11 | Whole capability suite once; static gates; record the green run; move pattern-map rows P0104, P0419, P0601, P0618 to `spec'd` (the loop moves them to `verified`) | VII.9 | `test-spec.sh notifications` |
| WP-12 | W03: popover reads the inbox (`GET /notifications`, count, mark read, live `notification` on `user:<id>`), preferences screen, unsubscribe page, devices call updated; Playwright happy paths | G-41 | `pnpm --dir packages/web` unit/component + `e2e/notifications.spec.ts` (if the stack is available; otherwise listed in Ops artifacts) |

Order exceptions: WP-5 needs WP-3/4; WP-7 can run in parallel with WP-6 after WP-2; WP-12 last.

## Gap coverage

G-01 WP-9 · G-02/03/05/06 WP-3 · G-04/09/13/18/22/23 WP-5 · G-07/26/37 WP-4 · G-08 WP-1 · G-10/14/15/16/17/27 WP-6 · G-11/12 WP-3 · G-19/20/21/24/25/28/29/30 WP-7 · G-31..36 WP-8 · G-38/40 WP-9 · G-39 WP-2 · G-41 WP-12 · G-42 WP-10 · D-6 WP-2 · D-7/D-12 WP-4 · D-8 WP-9 · section 3 lines WP-4/WP-10 · section 4 WP-11 · rows from "Follow-ups" above.
