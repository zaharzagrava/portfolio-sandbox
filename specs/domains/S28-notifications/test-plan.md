# Test Plan: S28 — Notification routing (domain `notifications`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (87 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. A unit entry proves the pure rule table; an API e2e entry of the same row (when both appear) proves one wired case through the real modules, never the table again.

- API e2e files live in `packages/backend/libs/domains/notifications/` and boot the real `NotificationsModule`, `NotificationsWorkerModule` and `NotificationsProjectorModule` (plus the identity, tenancy and rate-limit modules they import) with the production global prefix, `ValidationPipe`, problem+json filter and interceptors, called through `supertest`. Each file's top-level `describe` names its feature (VII.8):
  - `notifications-routing.e2e-spec.ts` — describe "Notifications: event routing, recipients and exactly-once"
  - `notifications-preferences.e2e-spec.ts` — describe "Notifications: preferences, settings, phone verification, devices and unsubscribe"
  - `notifications-quiet-caps.e2e-spec.ts` — describe "Notifications: quiet hours, expiry and frequency caps"
  - `notifications-delivery.e2e-spec.ts` — describe "Notifications: channel lines, providers, failover and retries" (includes the VII.4 duplicate-delivery and invalid-payload tests of the delivery worker)
  - `notifications-inbox.e2e-spec.ts` — describe "Notifications: inbox and unread counter"
  - `notifications-callbacks.e2e-spec.ts` — describe "Notifications: provider callbacks and suppression" (includes the VII.4 tests of the callback worker)
  - `notifications-catalog.e2e-spec.ts` — describe "Notifications: catalog completeness" (one `it.each` over the catalog rows)
  - `notifications-observability.e2e-spec.ts` — describe "Notifications: logs and metrics"
  - The existing `notifications.e2e-spec.ts` is split into these files and deleted: its 4 tests move to AS-01/AS-02, AS-30/AS-31, AS-25 and AS-67 and are rewritten (no `ShopMembership`, no fixed `setTimeout`, new event shapes).
- Users, shops, memberships and sessions are seeded only through shared fixture helpers and the exported services of identity (`SessionIssuer`) and tenancy; no spec injects `UserModel` or `ShopMembershipModel` (D-7). Real engines: Postgres, Redis, the wide-column store, the SQS stand-in (ElasticMQ), with real migrations. Only system edges are faked: identity token verification, the three providers (spied at the SDK boundary and able to fail, hang, or return permanent errors on demand), the SNS signing-certificate fetch, the realtime hub transport where a fault is forced, the rate-limit and cap stores where an outage is forced (switchable wrappers), and the clock (frozen and advanced).
- Source events and messages are delivered through the consumer entry points the framework (S53) calls, with schema-valid envelopes built from the `packages/contracts` event schemas; no spec constructs the old `OrderPaid` / `AuctionLeaderChanged` classes with the previous payloads.
- Every e2e test asserts the response body **and** the persisted state (inbox rows, timeline rows, queue contents, scheduled jobs, suppression and preference rows, counters). Waiting uses `waitFor` on a condition, never a fixed sleep.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `event-mapping.spec.ts`, `quiet-hours.spec.ts` (extends the existing file), `backoff.spec.ts`, `delivery-status.spec.ts`, `templates.spec.ts`, `money.spec.ts`; `fast-check` properties for the status precedence (never regresses) and for the quiet-hours function (result is never inside the window, never earlier than `now`, and is the first instant after `now` outside it).
- UI journeys (Playwright) are owned by W03 in `packages/web/e2e/notifications.spec.ts` (bell and popover) and a preferences journey in the same file, happy path only: a buyer pays, the bell shows `1` live, the popover lists the item, "mark all read" clears the badge; the same user opens the preferences screen, switches `orders / email` off and saves quiet hours, reloads and sees both; a recipient opens an unsubscribe link, sees the confirmation page (GET describes), presses the button (POST) and sees the result. Rows reference them in the UI column. No edge case is re-tested there.
- Static gates (VII.1, IX.5, X.6): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-83); `pnpm check:module-graph`; `pnpm check:model-registry`.
- Gate 9 (VII.9) fallback/degradation tests that force the fault: AS-03 (queue refuses), AS-39 (cap store down), AS-43 (limiter down), AS-45 (breaker open), AS-53 (provider hangs), AS-61 (counter lost), AS-62 (crash between store and count), AS-63 (hub down).
- Concurrency tests use `Promise.all` and assert that exactly the allowed number succeed and the invariant holds (VII.3), repeated at least 20 times in one test: AS-02, AS-24, AS-36, AS-49, AS-58.
- Async consumers (VII.4): the event consumer (AS-02 duplicate, AS-04 invalid), the delivery worker (AS-49 duplicate, AS-50 invalid) and the callback worker (AS-70 duplicate, AS-69 invalid) each have both tests.
- The k6 scripts `scripts/load-tests/notifications-burst.test.js` (20,000 events per second marketing burst with a transactional probe) and `scripts/load-tests/notifications-inbox.test.js` (30,000 reads per second) prove SC-001, SC-003, SC-005 and SC-009. They are ops artifacts, not part of this table.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 happy path: order paid → inbox, unread, e-mail, realtime | `notifications-routing.e2e-spec.ts` | W03 `notifications.spec.ts` (bell and popover) | — |
| AS-02 duplicate and concurrent delivery of one event | `notifications-routing.e2e-spec.ts` | — | — |
| AS-03 crash and replay (queue refuses once) | `notifications-routing.e2e-spec.ts` | — | — |
| AS-04 invalid payload, poison isolation | `notifications-routing.e2e-spec.ts` | — | — |
| AS-05 unknown type ignored, unsupported version dead-lettered | `notifications-routing.e2e-spec.ts` | — | — |
| AS-06 unresolvable recipient, no e-mail address | `notifications-routing.e2e-spec.ts` | — | — |
| AS-07 shop recipients, batched lookups | `notifications-routing.e2e-spec.ts` | — | — |
| AS-08 address-targeted invitation | `notifications-routing.e2e-spec.ts` | — | — |
| AS-09 secrets travel once (reset token) | `notifications-routing.e2e-spec.ts` | — | — |
| AS-10 out-of-order version guard | `notifications-routing.e2e-spec.ts` | — | — |
| AS-11 stale event not sent externally | `notifications-routing.e2e-spec.ts` | — | — |
| AS-12 render failure isolated | `notifications-routing.e2e-spec.ts` | — | — |
| AS-13 event → request rules | — | — | `domain/event-mapping.spec.ts` |
| AS-14 default matrix | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-15 change a cell, effect on routing, idempotent | `notifications-preferences.e2e-spec.ts` | W03 preferences journey | — |
| AS-16 preference validation and 401 | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-17 mandatory notices vs opt-out and suppression | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-18 SMS opt-in needs a verified phone | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-19 settings and their effect | `notifications-preferences.e2e-spec.ts` | W03 preferences journey (quiet hours) | — |
| AS-20 settings validation | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-21 verify a phone | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-22 verification failures (wrong, expired, lock) | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-23 code request limits, unreachable phone | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-24 concurrent preference writes | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-25 one-click unsubscribe (GET describes, POST performs) | `notifications-preferences.e2e-spec.ts` | W03 unsubscribe page journey | — |
| AS-26 bad unsubscribe tokens, rate limit | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-27 unsubscribe link and headers only on non-mandatory mail | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-28 devices: register, move, cap, validation | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-29 device removal is owner-only | `notifications-preferences.e2e-spec.ts` | — | — |
| AS-30 quiet hours, delay up to 15 minutes | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-31 quiet hours, delay beyond 15 minutes (one scheduled job) | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-32 quiet hours affect push and SMS only; mandatory bypass | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-33 time-zone and DST arithmetic | — | — | `domain/quiet-hours.spec.ts` (+ property test) |
| AS-34 stale after waiting | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-35 marketing cap | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-36 cap under concurrency | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-37 cap and replay | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-38 rolling window and per-channel limits | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-39 cap store unavailable | `notifications-quiet-caps.e2e-spec.ts` | — | — |
| AS-40 channel bulkhead | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-41 priority isolation (marketing vs transactional, per channel) | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-42 provider rate budget, marketing budget | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-43 limiter outage fail modes | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-44 failover on transient failure | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-45 circuit breaker open, skip, half-open | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-46 permanent failure: suppress, remove token, no failover | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-47 retries and dead letter | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-48 backoff computation | — | — | `domain/backoff.spec.ts` |
| AS-49 duplicate queue message, concurrent copies | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-50 malformed queue message | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-51 suppression checked at send time | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-52 preference checked at send time | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-53 provider timeout | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-54 production configuration fails startup | `notifications-delivery.e2e-spec.ts` | — | — |
| AS-55 inbox paging across months | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-56 list validation, cursor, 401 | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-57 unread count | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-58 mark read once, concurrent tabs | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-59 mark read validation and ownership | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-60 mark all read, later arrivals stay unread | `notifications-inbox.e2e-spec.ts` | W03 `notifications.spec.ts` (mark all read) | — |
| AS-61 counter loss and rebuild | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-62 crash between store and count, reconciliation | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-63 realtime hub outage | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-64 retention 180 days | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-65 inbox opt-out per category | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-66 item content: locale at creation | `notifications-inbox.e2e-spec.ts` | — | — |
| AS-67 complaint → suppression, marketing e-mail off | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-68 permanent versus transient bounce | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-69 callback verification failures | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-70 acknowledge fast, process once | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-71 status never regresses | — | — | `domain/delivery-status.spec.ts` (+ property test) |
| AS-72 callback before our record | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-73 subscription confirmation host pinned | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-74 SMS status callbacks, STOP | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-75 SMS callback replay | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-76 suppression semantics | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-77 complaint for an unknown delivery | `notifications-callbacks.e2e-spec.ts` | — | — |
| AS-78 interpolation and escaping | — | — | `domain/templates.spec.ts` |
| AS-79 missing variable | — | — | `domain/templates.spec.ts` |
| AS-80 locale fallback | — | — | `domain/templates.spec.ts` |
| AS-81 money formatting | — | — | `domain/money.spec.ts` |
| AS-82 header, length and link safety | — | — | `domain/templates.spec.ts` |
| AS-83 data ownership (static) | static: `check:table-ownership --strict`, `check:model-registry` | — | — |
| AS-84 public surface and no direct callers (static) | static: `check:boundaries`, `check:module-graph` | — | — |
| AS-85 logs are clean | `notifications-observability.e2e-spec.ts` | — | — |
| AS-86 metrics | `notifications-observability.e2e-spec.ts` | — | — |
| AS-87 catalog completeness | `notifications-catalog.e2e-spec.ts` | — | — |

## Mandatory API cases per endpoint (VII.3) — where each is proven

| Endpoint | Happy | Validation classes | 401 | Other-user / IDOR | Concurrency | Rate limit 429 |
|---|---|---|---|---|---|---|
| `GET /notifications` | AS-55 | AS-56 | AS-56 | AS-55, AS-56 (foreign cursor) | — | AS-56 |
| `GET /notifications/unread-count` | AS-57 | — | AS-57 | AS-57 | — | — |
| `POST /notifications/read` | AS-58, AS-60 | AS-59 | AS-59 | AS-59 | AS-58 | AS-16 (shared write policy) |
| `GET/PUT /notifications/preferences` | AS-14, AS-15 | AS-16 | AS-16 | (principal only) | AS-24 | AS-16 |
| `PUT /notifications/settings` | AS-19 | AS-20 | AS-20 | (principal only) | — | AS-23 |
| `POST /notifications/settings/phone/*` | AS-21 | AS-22 | AS-22 | (principal only) | — | AS-23, AS-22 (lock) |
| `GET/POST/DELETE /notifications/devices` | AS-28 | AS-28, AS-29 | AS-28 | AS-29 | — | — |
| `GET/POST /notifications/unsubscribe` | AS-25 | AS-26 | n/a (anonymous) | AS-26 (foreign token) | — | AS-26 |
| `POST /notifications/webhooks/ses` | AS-67 | AS-69 | AS-69 (signature) | AS-69 (foreign topic) | AS-70 | — |
| `POST /notifications/webhooks/twilio` | AS-74 | AS-74 | AS-74 | — | — | — |
