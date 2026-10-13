# Quickstart: S28 — Notification routing (validation guide)

Runnable checks that prove the capability. Contracts: [contracts/http.md](contracts/http.md), [contracts/events.md](contracts/events.md), [contracts/services.md](contracts/services.md). Data: [data-model.md](data-model.md). Scenario → file mapping: [test-plan.md](test-plan.md).

## Prerequisites

- `docker compose -f docker-compose.test.yaml up -d` (Postgres, Redis, the wide-column store, ElasticMQ/SQS stand-in, Kafka stand-in) and migrations applied (`pnpm --dir packages/backend migrate:test` as the repository defines it).
- S28 adds Postgres migrations `20261013110000` to `20261013110500` (`pnpm db:jest:migrate:up`) and wide-column files `cql/050` to `cql/052` (`cql:migrate`, run with the `.env.test` contact points).
- Run backend commands from `packages/backend`.
- Secrets for tests come from the test config: a `NOTIFICATION_SECRET` distinct from the JWT secret.

## Baseline (WP-0, record the output here when run)

```bash
pnpm --dir packages/backend check:table-ownership     # expect `notifications`: "User" SQL, ShopMembership model, test rows (gaps.md section 3)
pnpm --dir packages/backend check:boundaries          # expect: 2 infra imports from application/api (D-6), barrel exports (D-8)
```

Baseline at plan time: `.ownership.baseline` = 2, `.tx.baseline` = 0 (direct `sequelize.transaction` sites in the domain; must stay 0).

Recorded at T001 (before any S28 code change):

- `check:table-ownership`: `notifications (2)` = `SQL User` in `application/preferences.service.ts` and `MODEL ShopMembershipModel` in `infra/notification-router.projector.ts`; equals `.ownership.baseline` = 2 and gaps.md section 3 (the gate skips spec files, so the two test rows of section 3 are not listed).
- `check:boundaries`: "no dependency violations found". The dependency-cruiser rules do not flag the `application/` and `api/` imports of `infra/` files (D-6: transactional-mail.service.ts, notification-router.service.ts, notification-webhooks.controller.ts, dev-mailbox.controller.ts); T080/T082 remove them.
- `grep -rn "sequelize.transaction"` over the domain: no match; `.tx.baseline` = 0.

## Scenario runs (narrowest first)

```bash
cd packages/backend
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/notifications/domain                 # six unit specs + quiet-hours (AS-13/33/48/71/78–82)
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications-routing                              # AS-01..AS-12
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications-preferences                          # AS-14..AS-29
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications-quiet-caps                           # AS-30..AS-39
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications-delivery                             # AS-40..AS-54
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications-inbox                                # AS-55..AS-66
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications-callbacks                            # AS-67..AS-77
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications-catalog                              # AS-87
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications-observability                        # AS-85, AS-86
/opt/sdd/repo/scripts/sdd/test-spec.sh notifications                                      # the whole capability, once at the end (WP-11)
```

Expected: every file green; each test asserts the response body and the persisted state (inbox rows, timeline, queue contents, jobs, counters); no fixed sleeps (`waitFor` only).

## Static gates

```bash
pnpm --dir packages/backend exec tsc --noEmit
pnpm --dir packages/backend lint
pnpm --dir packages/backend check:boundaries
pnpm --dir packages/backend check:module-graph
pnpm --dir packages/backend check:table-ownership --strict     # AS-83: notifications findings 2 → 0
pnpm --dir packages/backend check:model-registry
pnpm --dir packages/backend check:no-wallclock                 # domain/ reads time only via the injected clock
python3 scripts/livespec/check.py                              # living-spec page S28 consistent
grep -rn "sequelize.transaction" packages/backend/libs/domains/notifications   # expect no match (baseline 0)
grep -rn "NotificationRouter\b" packages/backend/libs packages/backend/apps    # expect no match outside the notifications domain's own tests (AS-84)
```

Cross-domain edits (CT-1) re-run: `test-spec.sh chat-sync`, `test-spec.sh crawler`, and the developer-platform webhook specs.

## Manual smoke (dev stack, `EMAIL_PROVIDER=memory`, `DEV_MAILBOX_ENABLED=true`)

1. Register a user, request a password reset: `GET /api/dev/mailbox` shows one mail with the link `<front>/reset-password#token=…`; logs hold no token.
2. Pay an order (checkout flow): bell shows `1` live; `GET /api/notifications` lists the item in the user's locale; confirmation mail in the dev mailbox carries `List-Unsubscribe`.
3. `POST /api/notifications/read {"all": true}` → `unread 0`.

## Recorded green run (T089)

From `packages/backend`, on the local test stack:

- `test-spec.sh libs/domains/notifications`: 10 e2e suites, 168 tests passed (routing, preferences, quiet-caps, delivery, inbox, callbacks, catalog, observability, foundation, dev-mailbox).
- `pnpm test libs/domains/notifications/domain`: 11 unit suites, 232 tests passed (event mapping, quiet hours, caps, backoff, delivery status with the property test, money, templates, cursor, ids, channel resolution, scrub).
- Cross-domain edits: `chat-sync` (5), `crawler` (5), developer-platform `webhooks` (5, one new), identity `ownership-gates`, `auth-password-reset`, `auth-observability`, `password-reset`: all passed (63 tests across the chat, seller-insights, developer-platform and identity files run together).
- Static: `tsc --noEmit` clean; `check:boundaries` no violations; `check:module-graph`, `check:model-registry`, `check:no-wallclock` pass; `check:table-ownership --strict` lists no `notifications` row (2 → 0) and still fails for 17 other domains' rows; eslint on the notifications, chat, seller-insights, developer-platform and projector files: no errors in files this work touched (two pre-existing errors remain in `chat/application/chat.service.ts` and `seller-insights/domain/extract-price.ts`); `python3 scripts/livespec/check.py`: 0 errors; no `sequelize.transaction` left in the notifications domain; no `NotificationRouter` in `packages/backend`.
- Web (`packages/web`): `tsc --noEmit` clean, eslint on the changed files clean, 100 vitest tests of the touched areas pass. The Playwright journeys (`tests/notifications.spec.ts`) were **not run**.
- Not run: the k6 scripts and the Playwright journeys (rows in `specs/UNVERIFIED.md`, status `not run`).

## Follow-ups from built specs, walked at T085

| From | Follow-up | Where it is met |
|---|---|---|
| S01 | consume `user_registered`, `registration_duplicate_attempted`, `password_changed`; reset mail through the port; no `"User"` access | `event-mapping.ts` rows, AS-09, AS-13, AS-87; `RecipientDirectoryAdapter` over `UserDirectoryService`; `check:table-ownership`: `notifications` has no row. `KNOWN_FOREIGN_ROWS` stays 7 (S01's ratchet is `≤`; it can drop, see gaps.md) |
| S02 | six `identity.mfa_*` / `federated_identity_*` events; `passwordInvalidated` variant | AS-13, AS-87 (`security.sign_in_method_added` variants, Ukrainian) |
| S03 | invite queue, offboarding events, `MembershipQueryService`; `payouts.read`, `sso.manage`, `403 shop_suspended` / `409 shop_offboarding` | AS-07, AS-08, AS-87. The three route rules are checked, n/a: S28 has no `ShopScoped` route (its endpoints are user-scoped) |
| S10 | renamed order fields, `order.refunded`, `order.fulfilment_changed` | `event-mapping.ts`, AS-01, AS-13, AS-87; `order.fulfilment_changed.userId` is in the contract already |
| S13 | `payments.payment_failed` through `paymentEventSchemas` | AS-13, AS-87 |
| S14 | `ledger.reconciliation_*` | not consumed (R-18, no recipient directory for finance staff) |
| S49 | `declareJobType` with payload contracts; `InvalidScheduleError`; discriminated `cancel` | `notification-delivery.job-types.ts`, AS-31, AS-62 |
| S50 | policies in the domain; structured headers; `503` / `422` answers | `rate-limit-policies.ts`, AS-16, AS-26, AS-56 |
| S52 | `l1: 'never'` for preferences, suppression and settings | AS-19 (cross-process effect), AS-76 |
| W01 | reset link `<front>/reset-password#token=`, dev mailbox | AS-09, `dev-mailbox.e2e-spec.ts` |
| W03 | no `unreadCount` in the event; preferences screen; unsubscribe page | `notificationRealtimeEventSchema`; the screens are in `packages/web` (see the W03 line of the Ops artifacts) |

## Ops artifacts (success criteria no automated test proves; each is also a row in `specs/UNVERIFIED.md`, status `not run`)

| Criterion | How to run it |
|---|---|
| SC-001 inbox item visible ≤ 2 s p99 at 115 ev/s avg, 2,000 ev/s peak | k6 `scripts/load-tests/notifications-burst.test.js` publishing `order.paid` events with a probe user polling the inbox |
| SC-002 zero duplicates at 3× delivery and 10 % random crashes at volume | same script with the crash-injection flag (`NOTIFICATIONS_CHAOS=0.1`) and a duplicate-count query on the timeline; per-crash-point correctness is proven by AS-03 |
| SC-003 other channels stay within 1.5× p99 while one provider is down | burst script with the SMS provider forced to hang; compare e-mail/push latency |
| SC-004 primary e-mail provider transient failure delays < 15 s p99, no loss | burst script with the primary e-mail provider returning 5xx for 60 s; count sent vs expected; single-failover behaviour is proven by AS-44 |
| SC-005 transactional sent < 1 s later during a 20,000/s marketing burst | burst script, marketing + transactional probe, compare p99 with and without burst; isolation is proven functionally by AS-41 |
| SC-006 zero cap violations in a 1,000,000-user simulation | simulation driver over `CapStore` with randomized concurrent admits; the atomic rule is proven by AS-36 at 20 parallel attempts |
| SC-009 inbox list / unread count at 30,000 rps, p99 < 150 ms / 50 ms | k6 `scripts/load-tests/notifications-inbox.test.js` |
| W03 Playwright journeys (bell, preferences, unsubscribe) | `pnpm --dir packages/web test:e2e tests/notifications.spec.ts` — written and type-checked, **not run** (needs the full stack; the unsubscribe describe-then-confirm journey also needs `NOTIFICATION_SECRET`) |

The k6 scripts live in `packages/backend/scripts/load-tests/` (`notifications-burst.test.js` needs a k6 binary with the xk6-kafka extension; both read `data/notifications.json`, written by `node scripts/load-tests/seed/index.js notifications`). They have not been run.

SC-007, SC-008, SC-010, SC-011, SC-012 are proven by AS-52/AS-34, AS-51/AS-67/AS-74, AS-85, AS-25, and the quiet-hours property test over a simulated year (AS-33) respectively; they are not Ops artifacts.
