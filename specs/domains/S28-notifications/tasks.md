---
description: "Task list for S28 — Notification routing (domain notifications)"
---

# Tasks: S28 — Notification routing (preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression)

**Input**: `specs/domains/S28-notifications/` — plan.md, spec.md, test-plan.md, gaps.md, questions.md (defaults accepted), research.md, data-model.md, contracts/{http,events,services}.md, quickstart.md. Constitution: `.specify/memory/constitution.md`.

**Tests**: REQUIRED (test-plan.md, 87 scenario rows). Test-first: every `AS-nn` failing-test task precedes the code task that makes it pass. Run the narrowest spec with `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>` from `packages/backend` (condensed output; open the full log only if needed); run the whole capability suite once, in the Polish phase. After 5 failed fix attempts on the same test, stop and write the blocker, what was tried and the hypothesis into `questions.md`.

**Rules that apply to every task**
- Rule 0: the living-spec page `docs/spec/capabilities/S28-notifications.md` is written first (T003); keep `python3 scripts/livespec/check.py` green; never create or edit `*.reviewed.json`; anything human-signed that changes goes under `## Spec changes` in gaps.md.
- Rule 1: never edit another capability's spec; sibling needs are bullets under `## Sibling-spec follow-ups` in gaps.md (written by the plan; extend if a task reveals more).
- Rule 2: SC-nnn not proven by a test stay under "Ops artifacts" in quickstart.md and as rows in `specs/UNVERIFIED.md` (status `not run`); never call them verified.
- Rule 3: no git checkout/restore/reset/stash/clean; undo by hand-editing only the lines concerned.
- Rule 4: transactions only through `TransactionRunner.run` / `@Transactional`; no new direct `sequelize.transaction` (baseline `.tx.baseline` = 0); delete any `// S54 T037 audit` comment on a site you migrate.
- Abbreviations: `B` = `packages/backend/libs/domains/notifications`, `C` = `packages/contracts/src/notifications`, `TS` = `/opt/sdd/repo/scripts/sdd/test-spec.sh`, `UNIT` = `TS libs/domains/notifications/domain`. Backend commands run from `packages/backend`.

## Format: `- [ ] Tnnn [P?] [US?] Description with file path` (`[P]` = different files, no dependency on an unfinished task)

## User stories (spec.md)

US1 exactly-once routing (P1) · US2 preferences, settings, phone, devices, unsubscribe (P1) · US3 quiet hours and caps (P1) · US4 lines, providers, failover, retries (P1) · US5 inbox and bell (P1) · US6 callbacks and suppression (P2) · US7 templates, locale, safety (P2) · US8 boundaries and observability (P2)

---

## Phase 1: Setup (WP-0)

- [X] T001 Run `pnpm --dir packages/backend check:table-ownership` and `check:boundaries`; paste the `notifications` findings into quickstart.md section "Baseline" and reconcile them with gaps.md section 3 (expected `.ownership.baseline` = 2, `.tx.baseline` = 0; any difference is written into gaps.md section 3).
- [X] T002 Verify `specs/UNVERIFIED.md` has one S28 row per Ops artifact of quickstart.md (SC-001..SC-006, SC-009, W03 journeys), each with spec, criterion, how to run it, status `not run`; add any missing row; never describe one as verified.
- [X] T003 Create the living-spec page `docs/spec/capabilities/S28-notifications.md` (rules and behaviors for routing, preferences, quiet hours/caps, lines/failover, inbox, callbacks/suppression, templates, boundaries; `[proof:]`/`[code:]` clauses pointing at the test files of test-plan.md; scope globs `packages/backend/libs/domains/notifications/**` and `packages/contracts/src/notifications/**`); run `python3 scripts/livespec/check.py`; check the S01 (reset mail) and W03 (bell) pages for signed statements that now change and list them under `## Spec changes` in `specs/domains/S28-notifications/gaps.md`.
- [X] T004 Confirm `fast-check` is a devDependency of `packages/backend`; if absent add it to `packages/backend/package.json`.

---

## Phase 2: Foundational (blocking prerequisites: WP-1 contracts/ports, WP-2 storage)

**⚠️ No user story starts before this phase is done.** Unit specs for pure rules are written in the story that owns them (AS-13 US1, AS-33 US3, AS-48 US4, AS-71 US6, AS-78–82 US7).

- [X] T005 [P] Create `packages/contracts/src/notifications/http.ts` with zod schemas for every route of contracts/http.md: `listNotificationsQuerySchema` (`limit` int 1..50 default 20, `cursor` opaque ≤ 512), `notificationPageSchema`/`notificationItemSchema` (title ≤ 120 characters, body ≤ 500), `unreadCountSchema` `{unread: int 0..1000}`, `markReadRequestSchema` (exactly one of `ids` uuid-shaped 1..100 or `all: true`), `notificationPreferencesSchema` (with `mandatoryChannels`, masked `phone`, `phoneVerified`), `updatePreferenceRequestSchema` `{category ∈ 13, channel ∈ 4, enabled}`, `updateSettingsRequestSchema` (`quietStart`/`quietEnd` `HH:MM` 24 h both-or-neither and not equal, `timezone` IANA, `locale` ∈ en|uk, `phone` E.164, null clears), `phoneVerifyRequestSchema` `{code: /^\d{6}$/}`, `deviceSchema` `{id, platform, lastSeenAt}`, `registerDeviceRequestSchema` `{token ≤ 4096, platform ∈ ios|android|web}`, `unsubscribeQuerySchema`; re-export from `packages/contracts/src/notifications/index.ts`.
- [X] T006 [P] Create `packages/contracts/src/notifications/consumed-events.ts` with consumer-side zod schemas for every producer without a contract file (rows of contracts/events.md marked `consumer`: identity incl. S02 events, `tenancy.invite_requested` body, offboarding, S04, S20, S21, S17, S15, S22, S24, S25, S41, S43, S26); reuse `paymentEventSchemas` (S13) and the S10 order schemas; `order.fulfilment_changed` needs `userId` (R-4); re-export.
- [X] T007 [P] Create `packages/contracts/src/notifications/realtime.ts` with `notificationRealtimeEventSchema` (no `unreadCount`, W03 follow-up) and re-export from `index.ts`.
- [X] T008 [P] Create `B/domain/types.ts`, `B/domain/errors.ts` (AppError codes: invalid_cursor, invalid_unsubscribe_token, phone_not_verified, phone_missing, quiet_hours_incomplete, quiet_hours_invalid, code_invalid, code_expired, phone_locked, device_not_found, rate_limited), `B/domain/metrics.ts` (names fixed in contracts/services.md), failover flag in `B/domain/provider-ports.ts`.
- [X] T009 Create `B/domain/ports.ts` with injection tokens and interfaces: PreferenceRepository, SettingsRepository, DeviceRepository, SuppressionRepository, InboxStore, DeliveryTimelineStore, CounterStore (unread, dirty), CapStore, DedupeStore, VersionGuardStore, ClaimStore, OtpStore, RecipientDirectory, FollowerAudience, RealtimeNotifier, DeliveryLineProducer, CallbackQueue, SendBudget, WakeScheduler, ProviderChain, Clock (data-model.md "Ports"). `domain/` imports no Nest/Date/Redis (`check:no-wallclock`).
- [X] T010 Migration in `packages/backend/migrations/` (expand only, `SET lock_timeout='3s'`, `ADD COLUMN IF NOT EXISTS`, no default, no rewrite): `NotificationSettings.phoneVerifiedAt timestamptz NULL`; writing a different `phone` nulls it in the same statement.
- [X] T011 Migration in `packages/backend/migrations/`: CHECK `(quietStart IS NULL) = (quietEnd IS NULL)` on `NotificationSettings` as `NOT VALID`, with a resumable backfill that nulls half-set rows; a second migration runs `VALIDATE CONSTRAINT`.
- [X] T012 Migration in `packages/backend/migrations/`: `PushDevice.tokenHash char(64)` (SHA-256 of the token) with backfill, keep `token` and its unique index; `CREATE INDEX CONCURRENTLY` on `(userId, tokenHash)` and `(userId, lastSeenAt)` in their own migration; resumable one-off script that lower-cases/trims existing `NotificationSuppression.address` values.
- [X] T013 Wide-column DDL (in the store's migration mechanism): `ALTER TABLE notification_inbox ADD arrivedAt timestamp` (nullable; missing = `createdAt` when comparing); create `notification_inbox_state(userId, readAllBefore timestamp)`; add `failover boolean` to `notification_delivery`; create `notification_delivery_by_provider(provider, providerMessageId → deliveryId)` with 30-day TTL; keep inbox row TTL 15,552,000 s.
- [X] T014 Update the four models in `B/infra/models/` (+`phoneVerifiedAt`, +`tokenHash`) and run `pnpm --dir packages/backend check:model-registry`.
- [X] T015 [P] Repository adapters in `B/infra/repositories/` (preference, settings, device, suppression) implementing the ports; device delete predicate `WHERE id AND userId`; device cap eviction via `TransactionRunner.run` (two statements, no network I/O).
- [X] T016 [P] Store adapters: `B/infra/inbox.store.ts` (insert `IF NOT EXISTS` returning "new", mark-read `IF read = false`, watermark), `B/infra/delivery-timeline.store.ts` (summary row, conditional update by rank, by-provider lookup), `B/infra/redis-stores.ts` (keys and TTLs of data-model.md "Redis keys": done, ver, cap, cap:dec, unread, unread:dirty, claim, sent, otp*, `rv:`), all with timeouts (Redis 200 ms, wide-column 1 s).
- [X] T017 [P] `B/infra/recipient-directory.adapter.ts` wrapping `UserDirectoryService.getUsersByIds` (identity) and `MembershipQueryService.getMembersByShopIds(ids, ['OWNER'])` (tenancy), ≤ 500 ids per call, 2 s timeout; `B/infra/follower-audience.adapter.ts` fail-closed stub (R-5, CT-2); `B/infra/realtime.adapter.ts` wrapping `RealtimePublisher` (500 ms).
- [X] T018 [P] `B/rate-limit-policies.ts`: `definePolicies` + `forFeature` for `notifications.read.user`, `notifications.write.user`, `notifications.phone-code.user` (3/hour), `notifications.phone-verify.user`, `notifications.unsubscribe.ip`, `notifications.webhook.ip` and send budgets `notify.<channel>` / `notify.<channel>.marketing` (20 %); adopt structured `RateLimit`/`RateLimit-Policy` headers and `503 rate_limiter_unavailable` / `422 rate_limit_cost_exceeded`.
- [X] T019 [P] `B/infra/notifications.config.ts`: S54 config schema with dedicated required `notification_secret` (no JWT fallback) and provider credentials required in production (startup fails); `B/infra/notifications.topics.ts` topic constants; shared `l1: 'never'` option for preference/suppression/site records (S52).
- [X] T020 Create module skeletons `B/notifications.module.ts`, `B/notifications-worker.module.ts`, `B/notifications-projector.module.ts` (new), `B/notifications-core.module.ts` (internal); `declareJobType` with payload contracts for `notifications.wake-delivery` and `notifications.reconcile-unread` beside the `JobPayloads` augmentation (`B/application/notification-delivery.job-types.ts`; catch `InvalidScheduleError`, adapt to the discriminated `JobsService.cancel` result).
- [X] T021 Shared e2e fixtures for the 8 spec files in `B/testing/`: seed users via `SessionIssuer`, shops/memberships via tenancy exported services, frozen/advanceable clock, provider spies at the SDK boundary (fail, hang, permanent error), switchable cap/rate-limit store wrappers, schema-valid envelope builders from `packages/contracts`, `waitFor` helper; no `UserModel`/`ShopMembershipModel` injection (D-7).

**Checkpoint**: contracts compile, ports defined, migrations applied, `tsc --noEmit` green.

---

## Phase 3: User Story 1 — exactly-once routing (Priority: P1) 🎯 MVP

**Goal**: a fact happens, the right people hear about it exactly once. **Independent test**: publish `order.paid` for a seeded buyer and shop; assert inbox item, unread count, queued/sent e-mail, then deliver the event again (`notifications-routing`). Covers G-02..G-08, G-11, G-12 (routing part), D-7, D-12 and the S01/S03/S10/S13 follow-ups.

- [X] T022 [P] [US1] Write failing unit spec `B/domain/event-mapping.spec.ts` (`it.each`): AS-13 event → request rules for every catalog row of contracts/events.md (recipients, ignored reasons such as `payment_failed` with `order_not_payable`, one `shop.order_received` per `shopOrders[]` entry, S10 renamed fields `totalMinor`, `unitPriceMinor`, `paymentRef`, `orderVersion`, `previousStatus`).
- [X] T023 [US1] Write failing e2e `B/notifications-routing.e2e-spec.ts` (describe "Notifications: event routing, recipients and exactly-once"), tests AS-01 (order paid → inbox item, unread, e-mail, realtime) and AS-02 (duplicate + concurrent delivery, `Promise.all` ×20).
- [X] T024 [US1] Add to `notifications-routing.e2e-spec.ts` failing tests AS-03 (crash points: queue refuses once, replay yields exactly one of each), AS-04 (invalid payload dead-lettered with reason, siblings in the batch continue), AS-05 (unknown type ignored + `notifications_events_ignored_total`, unsupported version dead-lettered).
- [X] T025 [US1] Add failing tests AS-06 (unresolvable recipient / no e-mail address counted, no throw), AS-07 (shop owners, batched lookups: one membership call per consumed batch), AS-08 (address-targeted `tenancy.invite_requested` from queue `tenancy-invite-requested`, link `<front>/invites/<token>`), AS-09 (secrets travel once: reset mail via the `PASSWORD_RESET_MAILER` port + dev mailbox link `<front>/reset-password#token=`, token absent from logs, timeline, dead letters).
- [X] T026 [US1] Add failing tests AS-10 (out-of-order version guard drops lower versions), AS-11 (stale event not sent externally, timeline `expired`, inbox kept), AS-12 (render failure isolated to one request).
- [X] T027 [US1] Implement `B/domain/event-mapping.ts` and the `B/domain/catalog.ts` skeleton (13 categories) so `event-mapping.spec.ts` passes: one typed mapping per catalog row; recipient kinds `user | shopOwners | address | followers`; maxAge per type. Run `UNIT`.
- [X] T028 [US1] Implement `B/application/event-routing.service.ts`: per-request isolation (render → validate → act), dead-letter reasons `invalid_payload|unsupported_version|render_failed` (no body/token in the record), ignored counter, version guard (compare-and-set script, 7-day memory, G-05), maximum age at consumption (injected clock, no `new Date()`, G-06).
- [X] T029 [US1] Implement consumers in `B/infra/consumers/`, one per source family over the S53 framework (identity incl. S02 events, tenancy, S04, orders, payments with `paymentEventSchemas`, delivery, auctions, billing, payouts, launch-events, chat, discussions, seller-insights, developer-platform, feed) plus `B/infra/invite.consumer.ts` for queue `tenancy-invite-requested`; migrate `B/infra/notification-router.projector.ts` to the S10 payload names.
- [X] T030 [US1] Implement `B/application/recipient-view.service.ts` (batched `RecipientDirectory`, `rv:` cache via S52 with `l1: 'never'`, invalidated on write); delete the `"User"` join (`preferences.service.ts:128`) and the `ShopMembership` model import/injection in the projector (D-7, D-12, G-37).
- [X] T031 [US1] Implement router steps in `B/application/notification-router.service.ts`: deterministic delivery ids, done marker as shortcut only (G-04), inbox insert that says "new", counter increment only for new items (dirty-set repair), best-effort realtime, line enqueue; `application/` imports no `infra/` (D-6).
- [X] T032 [US1] Extend `B/application/transactional-mail.service.ts`: reuse catalog type + templates + redaction for the reset mail through `PASSWORD_RESET_MAILER` (widen `DeliveryMessage.type` by `'auth.password_reset'`), link `<front>/reset-password#token=<token>`; extend `dev-mailbox.e2e-spec.ts` (`GET /api/dev/mailbox`, `DEV_MAILBOX_ENABLED=true`).
- [X] T033 [US1] Run `TS notifications-routing` and `UNIT`; AS-01..AS-13 green (5-attempt rule applies).

**Checkpoint**: US1 is the MVP — events become exactly one inbox item and one queued delivery per channel.

---

## Phase 4: User Story 2 — preferences, settings, phone, devices, unsubscribe (Priority: P1)

**Goal**: I decide what I hear. **Independent test**: read the default matrix, flip a cell, route an event, assert the channel is skipped; follow an unsubscribe link (`notifications-preferences`). Covers G-24..G-30, G-26.

- [X] T034 [US2] Write failing e2e `B/notifications-preferences.e2e-spec.ts` (describe "Notifications: preferences, settings, phone verification, devices and unsubscribe"): AS-14 (default matrix: marketing external off, SMS off, inapp on, `mandatoryChannels`), AS-15 (change a cell, effect on routing, idempotent PUT), AS-16 (validation, 401, 429 on the write policy).
- [X] T035 [US2] Add failing tests AS-17 (mandatory notices vs opt-out and suppression), AS-18 (SMS opt-in needs verified phone → `422 phone_not_verified`), AS-19 (settings and their cross-process effect with `l1:'never'`), AS-20 (settings validation: `quiet_hours_incomplete`, `quiet_hours_invalid`, timezone, locale, phone).
- [X] T036 [US2] Add failing tests AS-21 (verify a phone: 6 digits, 10 minutes, masked phone, `phoneVerified`), AS-22 (wrong, expired, lock after 5 failures for 15 minutes), AS-23 (3 code requests per hour, unreachable phone, `422 phone_missing`).
- [X] T037 [US2] Add failing tests AS-24 (concurrent preference writes ×20, one consistent final row), AS-25 (one-click unsubscribe: GET describes without state change, POST performs), AS-26 (bad/foreign tokens `400 invalid_unsubscribe_token`, `notifications.unsubscribe.ip` 429), AS-27 (unsubscribe link and `List-Unsubscribe` headers only on non-mandatory mail, asserted through the provider spy).
- [X] T038 [US2] Add failing tests AS-28 (devices: register `201|200 {id,…}`, token moves to the latest user, cap 10 evicts the oldest, validation, 401), AS-29 (`DELETE /notifications/devices/:deviceId` owner-only, `404 device_not_found` for another user's id).
- [X] T039 [US2] Implement `B/application/preferences.service.ts` and `B/application/settings.service.ts` over repository ports (defaults per spec Defaults, `mandatoryChannels`, validation with the `packages/contracts/src/notifications/http.ts` schemas, invalidate the recipient view on write, replace the `User` join with `getUsersByIds`) including phone OTP (`OtpStore`, 6 digits, 10 min, 5 attempts then 15 min lock, `security.phone_verification` sms, immediate, no inbox).
- [X] T040 [US2] Implement `B/application/device.service.ts` and `B/application/unsubscribe.service.ts` (dedicated-key token, `invalid_unsubscribe_token`); `B/application/suppression.service.ts` normalization used by sends.
- [X] T041 [US2] Implement controllers `B/api/preferences.controller.ts`, `B/api/devices.controller.ts`, `B/api/unsubscribe.controller.ts` and `B/api/notifications.dto.ts` (zod pipes from contracts, no class-validator, no HTTP try/catch, S50 policies applied); remove the ad-hoc `BadRequestException`s.
- [X] T042 [P] [US2] Web W03 (G-41): preferences screen `packages/web/app/…/settings/notifications` and unsubscribe page `packages/web/app/unsubscribe` (Server Component with a client button: GET describes, POST performs), `packages/web/lib/api/notifications.ts` + `packages/web/lib/query-keys.ts`, device calls on the new endpoints; Playwright preferences and unsubscribe journeys in `packages/web/e2e/notifications.spec.ts`.
- [X] T043 [US2] Run `TS notifications-preferences`; AS-14..AS-29 green.

---

## Phase 5: User Story 3 — quiet hours and frequency caps (Priority: P1)

**Goal**: respect people's time and attention. **Independent test**: quiet hours around "now", route an outbid event → delayed push, immediate inbox item; route 4 marketing notices → 4th capped (`notifications-quiet-caps`). Covers G-09, G-13.

- [X] T044 [P] [US3] Extend failing unit spec `B/domain/quiet-hours.spec.ts` (AS-33 time zone and DST arithmetic, `it.each` over zones and DST dates) plus a `fast-check` property (result never inside the window, never earlier than `now`, first instant after `now` outside it; a simulated full year, SC-012).
- [X] T045 [US3] Write failing e2e `B/notifications-quiet-caps.e2e-spec.ts` (describe "Notifications: quiet hours, expiry and frequency caps"): AS-30 (delay ≤ 900 s on the line), AS-31 (delay beyond 900 s: exactly one scheduled S49 job `notifications.wake-delivery`, asserted through the scheduler's inspection helper, not raw `"Job"` SQL), AS-32 (quiet hours affect push and SMS only; mandatory and phone-verification bypass), AS-34 (stale after waiting: maximum age re-checked at wake).
- [X] T046 [US3] Add failing tests AS-35 (marketing cap: push 3/hour, e-mail 2/24 h, SMS 1/24 h), AS-36 (cap under concurrency, `Promise.all` ×20, exactly the allowed number admitted), AS-37 (cap and replay: first decision per delivery id is final), AS-38 (rolling window, per-channel limits), AS-39 (cap store unavailable: marketing fail-closed, transactional unaffected).
- [X] T047 [US3] Complete `B/domain/quiet-hours.ts` (injected clock, no `Date`) and `B/domain/cap-window.ts` (rolling-window arithmetic) so the unit specs pass; run `UNIT`.
- [X] T048 [US3] Implement caps and quiet hours in the router (`B/application/notification-router.service.ts`): atomic admit-or-reject script in `CapStore` (`cap:<userId>:<channel>` zset, `cap:dec:<deliveryId>` final decision, fail-closed for marketing on outage); quiet-hours scheduling (SQS delay ≤ 900 s, beyond that a `WakeScheduler` S49 job, wake-time re-check of maximum age, suppression and preference); statuses `capped|expired`.
- [X] T049 [US3] Run `TS notifications-quiet-caps` and `UNIT`; AS-30..AS-39 green.

---

## Phase 6: User Story 4 — lines, providers, failover, retries (Priority: P1)

**Goal**: a provider outage or a campaign never blocks the rest. **Independent test**: SMS provider fails, route one event with e-mail and SMS → e-mail sent, SMS retried (`notifications-delivery`). Covers G-10, G-14..G-17, G-27.

- [X] T050 [P] [US4] Write failing unit spec `B/domain/backoff.spec.ts` (AS-48: base 30 s, factor 2, cap 900 s, full-jitter bounds with injected random, 5 attempts).
- [X] T051 [US4] Write failing e2e `B/notifications-delivery.e2e-spec.ts` (describe "Notifications: channel lines, providers, failover and retries"): AS-40 (channel bulkhead), AS-41 (marketing vs transactional isolation per channel), AS-42 (provider rate budget, marketing budget 20 %), AS-43 (limiter outage: transactional fail-open, marketing fail-closed with 60 s delay).
- [X] T052 [US4] Add failing tests AS-44 (failover on transient failure, `failover` flag in timeline), AS-45 (circuit breaker open → skip → half-open, `notifications_provider_circuit_state`), AS-46 (permanent failure: suppress / remove token, no failover), AS-47 (retries with backoff, explicit dead-letter move, `failed/exhausted`).
- [X] T053 [US4] Add failing tests AS-49 (duplicate queue message and concurrent copies ×20: one provider call), AS-50 (malformed queue message dead-lettered without body), AS-51 (suppression checked at send time), AS-52 (preference re-checked at send time, status `skipped`), AS-53 (provider timeout 10 s), AS-54 (production configuration without credentials or `notification_secret` fails startup; stand-ins report `provider: "log"`, never `delivered`).
- [X] T054 [US4] Implement `B/domain/backoff.ts` (pure) and the `B/domain/delivery-status.ts` ranks the worker needs; run `UNIT`.
- [X] T055 [US4] Implement `B/infra/delivery-lines.ts`: six queues (`notify-{email,sms,push}`, `notify-marketing-{email,sms,push}`) each with `…-dlq`, per-line concurrency (marketing lower; 10 transactional + 3 marketing).
- [X] T056 [US4] Implement `B/application/delivery-worker.service.ts` and wire `B/infra/notification-workers.service.ts`: atomic claim (`claim:<deliveryId>`, 90 s) and `sent:` marker, payload validation, send-time checks (suppression, preference, maximum age; `skipped`/`expired`), S50 send budgets with fail modes, provider chain with failover flag and breaker gauge, backoff with explicit dead-letter move and counter, 10 s provider timeout; handler for job `notifications.wake-delivery`.
- [X] T057 [US4] Update `B/infra/notification-providers.ts` and `B/infra/providers/` (explicit stand-ins outside production, startup failure in production, unsubscribe key from `notification_secret` only).
- [X] T058 [US4] Run `TS notifications-delivery` and `UNIT`; AS-40..AS-54 green.

---

## Phase 7: User Story 5 — inbox and bell (Priority: P1)

**Goal**: my inbox and bell are always right. **Independent test**: route three events, list, mark one read, mark all read, assert counts and flags (`notifications-inbox`). Covers G-18..G-23, G-41 (bell).

- [X] T059 [US5] Write failing e2e `B/notifications-inbox.e2e-spec.ts` (describe "Notifications: inbox and unread counter"): AS-55 (paging across months, foreign-user isolation), AS-56 (limit validation, signed user-bound cursor, `400 invalid_cursor`, foreign cursor, 401, 429), AS-57 (unread count), AS-58 (mark read once, concurrent tabs ×20), AS-59 (mark-read validation: `ids`+`all`, garbage ids, ownership, 401).
- [X] T060 [US5] Add failing tests AS-60 (mark all read; later arrivals stay unread; an event older than the mark-all moment stays unread), AS-61 (counter loss and rebuild, bound 1,000), AS-62 (crash between store and count; 5-minute reconciliation job `notifications.reconcile-unread`), AS-63 (realtime hub outage does not fail the add; `notifications_realtime_publish_failed_total`).
- [X] T061 [US5] Add failing tests AS-64 (retention 180 days by age), AS-65 (inbox opt-out per category), AS-66 (item content locale fixed at creation, title ≤ 120, body ≤ 500, relative links only).
- [X] T062 [US5] Implement `B/domain/cursor.ts` (signed, user-bound, opaque) and `B/application/inbox.service.ts` (list by 180-day age, `arrivedAt` watermark compare, LWT mark-read, rebuild from the inbox when the counter is absent, validated identifiers and length limits) over `InboxStore`/`CounterStore`.
- [X] T063 [US5] Implement `B/api/notifications.controller.ts` (`GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/read`) with contract schemas and the `notifications.read.user` / `notifications.write.user` policies; `B/application/unread-reconcile.service.ts` and its job handler (`fleetConcurrency: 1`, idempotent).
- [X] T064 [P] [US5] Web W03 (G-41): rewrite `packages/web/components/notifications-popover.tsx` to load `GET /notifications`, mark read via `POST /notifications/read`, listen to event `notification` on `user:<userId>` (not topic `notifications`), re-read `unread-count` on focus and reconnect; Playwright bell journey (live `1`, mark all read) in `packages/web/e2e/notifications.spec.ts`.
- [X] T065 [US5] Run `TS notifications-inbox`; AS-55..AS-66 green.

---

## Phase 8: User Story 6 — callbacks and suppression (Priority: P2)

**Goal**: bad addresses and complaints stop mail for good. **Independent test**: a signed SES complaint for a delivered e-mail, then route another event; the provider is not called (`notifications-callbacks`). Covers G-31..G-36.

- [X] T066 [P] [US6] Write failing unit spec `B/domain/delivery-status.spec.ts` (AS-71: precedence table of data-model.md, `fast-check` property that status rank never drops; `complained` outranks `bounced`/`delivered`; pre-send terminals never reach `sent`).
- [X] T067 [US6] Write failing e2e `B/notifications-callbacks.e2e-spec.ts` (describe "Notifications: provider callbacks and suppression"): AS-67 (complaint → suppression, marketing e-mail off, no further send, SC-008), AS-68 (permanent vs transient bounce), AS-69 (verification failures: signature, foreign topic, cert host, timestamp > 5 min, non-JSON outer/inner → 401/400), AS-70 (acknowledge fast; callback worker processes once; duplicate and invalid-message VII.4 tests).
- [X] T068 [US6] Add failing tests AS-72 (callback before our record: retry up to 10 minutes), AS-73 (SNS subscription confirmation requires HTTPS and the SNS host pattern, no request otherwise), AS-74 (Twilio status callbacks, STOP normalized to E.164, bad signature/unconfigured token → 401), AS-75 (SMS callback replay deduped on `(MessageSid, MessageStatus)`), AS-76 (suppression semantics: trim/lowercase/E.164, immediate effect), AS-77 (complaint for an unknown delivery still suppresses by address, counted).
- [X] T069 [US6] Complete `B/domain/delivery-status.ts` (pure precedence rule, conditional update) so the spec passes; run `UNIT`.
- [X] T070 [US6] Implement `B/application/callback-intake.service.ts` and `B/application/callback-worker.service.ts` (verify → durable accept in queue `notifications-callbacks` with dedupe id = provider event id → worker applies); update `B/api/notification-webhooks.controller.ts` (intake only, no infra import) and `B/api/sns-verifier.ts` (5-minute tolerance, host pinning); `B/application/suppression.service.ts` normalization and immediate effect via the repository port (no 10-minute negative cache, `l1:'never'`); Twilio dedupe.
- [X] T071 [US6] Run `TS notifications-callbacks` and `UNIT`; AS-67..AS-77 green.

---

## Phase 9: User Story 7 — templates, locale, safety (Priority: P2)

**Goal**: messages read well in the recipient's language and cannot be abused. **Independent test**: render each template row in `en`, `uk` and an unsupported locale (unit specs). Covers G-08, G-12 (templates).

- [X] T072 [P] [US7] Write failing unit spec `B/domain/money.spec.ts` (AS-81: currency exponent — USD 2, JPY 0, KWD 3; locale formatting for en/uk; reject non-integers).
- [X] T073 [P] [US7] Write failing unit spec `B/domain/templates.spec.ts` (`it.each`): AS-78 interpolation and escaping, AS-79 missing variable → `render_failed`, AS-80 locale fallback (unsupported → en), AS-82 header injection, length limits and link safety (relative links only).
- [X] T074 [US7] Implement `B/domain/money.ts` and `B/domain/templates.ts` (remove hard-coded `'en-US'`/`'usd'` and `minor / 100`); run `UNIT`.
- [X] T075 [US7] Complete `B/domain/catalog.ts`: every row of the spec catalog (~45 types, 13 categories) with default channels, mandatory flag, recipient rule, maxAge or `until:<field>`, line (T/MK), inbox flag, link function, en + uk templates; `chat.message` without sender and without e-mail default; `order.cancelled` localized reason; `marketing.followed_shop_update` replaces `marketing.drop_starting`; `security.sign_in_method_added` variants for `passwordInvalidated: true` / `mfaReset: true` ("your password was removed"); billing variants for `authentication_required` and attempt number.
- [X] T076 [US7] Run `UNIT`; AS-78..AS-82 green.

---

## Phase 10: User Story 8 — boundaries and observability (Priority: P2)

**Goal**: the domain stays inside its boundaries and says what it is doing. **Independent test**: ownership and boundary gates; catalog table test. Covers G-01, G-38, G-39, G-40, D-6, D-8, CT-1.

- [X] T077 [US8] Write failing e2e `B/notifications-catalog.e2e-spec.ts` (describe "Notifications: catalog completeness", one `it.each` over catalog rows): AS-87 every row renders in en and uk, default channels valid, mandatory types carry no unsubscribe, categories ∈ 13, each row reachable from its source event.
- [X] T078 [US8] Write failing e2e `B/notifications-observability.e2e-spec.ts` (describe "Notifications: logs and metrics"): AS-85 (full flow with log capture: no contact data or secret in logs, metric labels, dead letters; SC-010), AS-86 (metrics of contracts/services.md exist with the fixed names and bounded labels).
- [X] T079 [US8] Implement metrics wiring and log redaction in the routing, delivery and callback paths (`B/domain/metrics.ts`, `B/application/*`); `resetToken` and invite `token` never reach logs (S01 follow-up).
- [X] T080 [US8] Shrink the barrel `B/index.ts` to `NotificationsModule`, `NotificationsWorkerModule`, `NotificationsProjectorModule`, `TransactionalMailModule` and contract types; update `packages/backend/apps/projector/src/projector.module.ts` to import `NotificationsProjectorModule` (G-38, D-8).
- [X] T081 [US8] CT-1 minimal edits in other domains: remove the `NotificationRouter` call and the `NotificationsCoreModule` import from `packages/backend/libs/domains/chat/infra/chat-offline.ts` + `chat-offline-worker.module.ts`, `packages/backend/libs/domains/seller-insights/application/crawler.service.ts` + `crawler.module.ts`, `packages/backend/libs/domains/developer-platform/application/webhook-deliverer.service.ts` + `webhooks-core.module.ts`; update `chat-sync.e2e-spec.ts` and `crawler.e2e-spec.ts` to assert the emitted event (`chat.message_escalated`, `seller_insights.competitor_price_dropped`, `developer_platform.webhook_endpoint_disabled`) instead of spying `dispatch`.
- [X] T082 [US8] Remove the 2 explicit `infra/` imports from `B/application/` and `B/api/` and the 4 store-holding services (everything via ports, D-6); confirm no direct `sequelize.transaction` remains (`grep -rn "sequelize.transaction" packages/backend/libs/domains/notifications` → no match).
- [X] T083 [US8] Run `TS notifications-catalog`, `TS notifications-observability`, `TS chat-sync`, `TS crawler` and the developer-platform webhook specs; then `pnpm --dir packages/backend check:boundaries`, `check:module-graph`, `check:table-ownership --strict`, `check:model-registry` (AS-83, AS-84: `notifications` findings 2 → 0).

---

## Phase 11: Polish & cross-cutting (WP-10, WP-11)

- [X] T084 Delete `B/notifications.e2e-spec.ts` after confirming its 4 tests live in AS-01/AS-02, AS-30/AS-31, AS-25 and AS-67 (no `ShopMembership`, no fixed `setTimeout`, no raw `"Job"` SQL, new event shapes).
- [X] T085 [P] Walk each cross-spec follow-up once more and cite it in the final report: S01 (three events, no `User` access, `KNOWN_FOREIGN_ROWS` note), S02 (six events), S03 (invite queue, offboarding, `MembershipQueryService`; `payouts.read`, `sso.manage`, `403 shop_suspended`/`409 shop_offboarding` recorded "checked, n/a" in quickstart.md), S10 (event rename), S13, S14 (not consumed, R-18), S49, S50, S52, W01, W03.
- [X] T086 [P] Confirm every item G-01..G-42, D-6, D-7, D-8, D-12 and the section 3 lines of gaps.md maps to a finished task (plan.md "Gap coverage"); extend `## Sibling-spec follow-ups` in gaps.md for any new need (S10 `userId` on `order.fulfilment_changed`, S26 `FollowQueryService`, S24/S41/S43 emitters, W03).
- [X] T087 [P] Write k6 scripts `scripts/load-tests/notifications-burst.test.js` and `scripts/load-tests/notifications-inbox.test.js` (Ops artifacts for SC-001..SC-005, SC-009; not run in CI); keep quickstart.md "Ops artifacts" and the `specs/UNVERIFIED.md` rows at `not run`.
- [X] T088 Static gates from `packages/backend`: `pnpm exec tsc --noEmit`, `pnpm lint`, `check:boundaries`, `check:module-graph`, `check:table-ownership --strict`, `check:model-registry`, `check:no-wallclock`; contracts package type-check and lint; `python3 scripts/livespec/check.py`; `grep -rn "NotificationRouter\b" packages/backend/libs packages/backend/apps` → no match outside the domain's own tests.
- [X] T089 Run the whole capability suite once: `TS notifications` (8 e2e files + 6 unit specs green) and record the green run in quickstart.md; move pattern-map rows P0104, P0419, P0601, P0618 in `docs/architecture/pattern-map.md` to `spec'd` (the loop moves them to `verified`).
- [X] T090 Run the W03 Playwright journeys (`pnpm --dir packages/web e2e notifications`) if the full stack is available and record the result; otherwise leave them under Ops artifacts as `not run`.

---

## Dependencies and execution order

- Phase 1 → Phase 2 (blocks everything) → stories.
- US1 first (MVP). US2, US3, US4, US5 need US1's router and Phase 2 only; US3 needs the US1 line enqueue; US4 needs the US1 lines; US6 needs US4's timeline/status; US7 can run beside US1 (its catalog rows feed AS-87 in US8); US8 last (barrel shrink and CT-1 edits once producers' specs are stable); Polish after all.
- Within a story: failing tests → pure domain → services → controllers/consumers → run the narrowest spec.
- Web tasks (T042, T064) after their backend endpoints are green.

## Parallel opportunities

- Phase 2: T005–T008 and T015–T019 are `[P]`.
- After Phase 2: US2 (HTTP) and US4 (workers) can run beside US1 once the storage work is done (plan: WP-7 beside WP-6); unit specs (T022, T044, T050, T066, T072, T073) `[P]` with anything.
- Web tasks T042 and T064 `[P]` once their endpoints exist.

## Implementation strategy

MVP = Phases 1–3 (US1). Then US2–US5 (all P1) in any order by capacity, then US6–US8 (P2), then Polish with the single full-suite run. Commit per green story.
