# Questions and decisions: S28 — Notification routing (domain `notifications`)

Decided unattended under the decision policy (most production-grade option the notes and the constitution support). Sorted by impact: BREAKING first, then CONTRACT, then LOCAL. `[BREAKING]` = changes behaviour or an API/UI contract that exists today (the implementation updates tests and callers).

## BREAKING

- [BREAKING] Other domains call `NotificationRouter.dispatch` (chat `infra/chat-offline.ts`, seller-insights `crawler.service.ts`, developer-platform `webhook-deliverer.service.ts`) → no router export; they publish events and S28 consumes them (`chat.message_escalated`, `seller_insights.competitor_price_dropped`, `developer_platform.webhook_endpoint_disabled`) → constitution IV.3/IX.7, projector comment "domains don't know notifications exist"; the barrel stops exporting `NotificationRouter`, `NotificationRouterProjector`, `NotificationsCoreModule`, `formatMoney` (D-8).
- [BREAKING] Recipient data (`User` join in `preferences.service.ts:128`, `ShopMembership` model in the projector) → identity `UserDirectoryService.getUsersByIds` and tenancy `MembershipQueryService.getMembersByShopIds` (R1, batched) → IX.4, debt D-7/D-12; the recipient view no longer holds a copy of the e-mail beyond its 5-minute lifetime.
- [BREAKING] Marketing defaults (today `push` is on by default, `defaultFor` in `preferences.service.ts:137`) → marketing is opt-in on email, sms and push; only the inbox is on → consent (ePrivacy/GDPR) and the notes' "marketing vs transactional" separation.
- [BREAKING] SMS enabling (today any E.164 number stored unverified, controller TODO) → OTP-verified phone required (`phone_not_verified` 422), new endpoints `POST /settings/phone/code` and `/verify`, settings and preferences responses mask the phone and add `phoneVerified` → an unverified number lets anyone make the platform text third parties (toll fraud, harassment).
- [BREAKING] Device API (`POST /devices` → 204, `DELETE /devices/:token` with no owner check) → `POST` returns `201|200 {id, platform, lastSeenAt}`, `GET /devices`, `DELETE /devices/:deviceId` owner-only (`404` otherwise), 10 devices per user → V.4/III.4 principal in the predicate, push tokens out of URLs and access logs.
- [BREAKING] Marketing queue (today one queue for all marketing channels, `notification-router.service.ts:111`) → one marketing line per channel → the notes' bulkhead (P0618) holds for marketing too; queue names change.
- [BREAKING] Inbox listing (`limit` clamped silently, raw `<bucket>:<pageState>` cursor, garbage ids give 500 in mark-read) → `400 validation_failed` for limit outside 1..50, signed user-bound opaque cursor with `400 invalid_cursor`, `400` for malformed ids and for `ids`+`all` combinations; foreign ids ignored → V.3, III.10, VII.3.
- [BREAKING] Mark-all-read watermark (compares `Date.now()` with the event-time id, `inbox.service.ts:124,86`) → read state follows arrival time, so an item whose event is older than the mark-all moment is still unread → today such an item is shown read while the counter counts it.
- [BREAKING] Callback authentication window (SNS replay window 1 h, `sns-verifier.ts:24`) → 5 minutes; SNS and Twilio callbacks acknowledged after durable acceptance and applied by a worker; deduplicated on the provider event id → constitution V.8, P0419.
- [BREAKING] Delivery status updates (unconditional overwrite, `delivery-log.service.ts:31`) → forward-only precedence rule; new statuses `skipped`, `expired` → out-of-order callbacks must not regress status.
- [BREAKING] Quiet hours and caps use the injected clock, not `new Date()`/`Date.now()` (`notification-router.service.ts:82,114,120,132`) → VII.2 frozen time; caps become a rolling window with an atomic admit and a final per-delivery decision (today fixed window, counts every attempt, replay double-counts).
- [BREAKING] Retry (today a thrown error and a fixed 60 s visibility timeout, `notification-workers.service.ts:45,89`) → exponential backoff with full jitter, 5 attempts, dead-letter with `failed/exhausted` → IV.6 and the notes' "retries w/ backoff, DLQ".
- [BREAKING] Provider stand-ins in production (log providers chosen silently when credentials are missing, `notification-providers.ts:31,41`) → startup fails in production; stand-ins only outside it and never reported `delivered` → VIII.5.
- [BREAKING] Unsubscribe secret falls back to the JWT secret (`notification-router.service.ts:63`, controller `:132`) → a dedicated required secret, no fallback; anonymous unsubscribe is rate limited → key separation.
- [BREAKING] Events carry minor units and currency; money is formatted per recipient locale with the currency's own exponent (today `'en-US'`, hard-coded `'usd'`, `minor / 100`, `notification-router.projector.ts:40-52`, `templates.ts:52`) → III.8 and i18n.
- [BREAKING] Event payload names (`price`, `total`, `finalPrice`) → S10/S21 names `totalMinor`, `priceMinor`, `finalPriceMinor` with `currency` and versions; `notifications.e2e-spec.ts` builds the old event classes (also S21 gaps A30) → follow the producers' specs.
- [BREAKING] Catalog changes: `chat.message` no longer has `{{sender}}` and e-mail by default (push, inapp) → S24 spec (no author name, push/inbox item); `order.cancelled` shows a localized reason, not the code; new categories `account`, `security`, `payouts`, `shop`, `bookings`, `discussions`; type `marketing.drop_starting` replaced by `marketing.followed_shop_update` → today it has no producer.
- [BREAKING] Stale events are not delivered externally (maximum age per type) and a quiet-hours delay re-checks it → replays of old topics and long delays must not send false news.
- [BREAKING] Preferences are re-checked at send time for non-mandatory deliveries (a push waiting for 07:30 is skipped if the user turned push off) → consent applies to what is actually sent.
- [BREAKING] Recipient view loses its in-process copy (`l1: 'hot'`, `preferences.service.ts:33`) → an opt-out must apply to every process as soon as it is acknowledged.

## CONTRACT

- [CONTRACT] `order.fulfilment_changed` has no `userId` in S10's spec → S28 requires `userId` as an additive payload field → the buyer cannot be resolved otherwise and S28 must not call S10 or read its tables (R1 would be a new export for a trivial field).
- [CONTRACT] Following graph for marketing → S28 requires S26 to export R1 `FollowQueryService.getFollowerIds(accountId, {limit ≤ 1000, cursor?})` (S26's spec exports nothing) → the notes' marketing path (caps, own line) needs a real audience; without it `marketing.followed_shop_update` is unsatisfiable. If S26 declines, the type is removed and the marketing engine stays unexercised in e2e.
- [CONTRACT] `seller_insights.competitor_price_dropped` v1 `{watchId, shopId, productId, productTitle, host, competitorPriceMinor, yourPriceMinor, currency, ownerId}` → S41 must emit it instead of calling the router.
- [CONTRACT] `developer_platform.webhook_endpoint_disabled` v1 `{endpointId, shopId, host, failingSince}` → S43 must emit it; `host` only, because endpoint URLs can carry secrets in their path or query.
- [CONTRACT] Recipient resolution → identity `UserDirectoryService.getUsersByIds` (S01) and tenancy `MembershipQueryService.getMembersByShopIds` (S03) as those specs define them → honoured unchanged.
- [CONTRACT] Single-consumer messages `identity.password_reset_requested` and `tenancy.invite_requested` (S01, S03) → consumed as a mandatory address/user e-mail, never stored, logged or dead-lettered with the token; links `<front>/reset-password?token=` and `<front>/invites/<token>` → the web routes must exist (W-capabilities).
- [CONTRACT] `chat.message_escalated` (S24) → honoured: type `chat.message` in category `chat`, dedupe on `dedupeKey`; the template drops the author name (S24 sends none).
- [CONTRACT] `auction.leader_changed` field `price` → `priceMinor` (S21) → honoured; S28 also consumes `auction.closed`, `second_chance_offered`, `sold`.
- [CONTRACT] Money events (S10, S13, S15, S17, S21) → `…Minor` plus `currency` → honoured.
- [CONTRACT] Realtime topic `user:<userId>` (event `notification`) is owner-only and registered outside S28 (S10 and S13 already publish `order.status`, `payment.status` on it) → S51/identity own the registration; the current web popover listens on a topic named `notifications` and must switch (W03).
- [CONTRACT] New rate-limit policies `notifications.read.user`, `notifications.write.user`, `notifications.phone-code.user`, `notifications.phone-verify.user`, `notifications.unsubscribe.ip`, `notifications.webhook.ip` and send budgets `notify.<channel>` and `notify.<channel>.marketing` → declared in S50's registry.
- [CONTRACT] No R1 exports from S28 and no `NotificationRouter`; apps import `NotificationsModule`, `NotificationsWorkerModule`, `NotificationsProjectorModule` → X.4; `apps/projector` currently imports internals (D-8).
- [CONTRACT] Not consumed in this release: `billing.subscription_status_changed` (status vocabulary unspecified for mail), `statements.*`, `ledger.reconciliation_*`, `payout.in_doubt|discrepancy_detected`, `integration_*`, `catalog_sync.*`, `order_export.finished`, `flash_sale.*`, `live.*` → no recipient directory for platform staff, and per-shop fan-out of statement-ready notices at 1M shops is out of scope; each is a catalog row away.
- [CONTRACT] `payments.payment_refunded` is not consumed; `order.refunded` (S10) is the buyer notice → one refund notice, not two. `payments.payment_succeeded` is not consumed; `order.paid` confirms → same reason. `delivery.status_changed` `DELIVERED` is not notified; `order.fulfilment_changed DELIVERED` is → courier delivery also moves the order, two notices would double.
- [CONTRACT] Shop-targeted notices go to OWNERs only → S03's role names (`OWNER`) used as in S03's spec; widening is a catalog change.

## LOCAL

- [LOCAL] Dedupe memory and version guards live in the fast store for 7 days → notes ("dedupe table with TTL"); deterministic ids make a lost memory harmless for the inbox and the delivery log.
- [LOCAL] Inbox first-insert tells whether an item is new and the counter is repaired by a 5-minute reconciliation → the counter is derived data (III.9).
- [LOCAL] Unread rebuild bound 1,000 → bounded work on a cold counter.
- [LOCAL] Caps keep today's numbers (push 3/h, email 2/day, sms 1/day), now rolling → notes "max 3 pushes/hour".
- [LOCAL] Marketing send budget 20 % of the channel's, marketing worker concurrency below transactional → "marketing burst drained at a capped rate".
- [LOCAL] Limiter outage: transactional fail-open, marketing fail-closed → availability of important mail beats strict budget; the provider's own 429 is transient.
- [LOCAL] Phone OTP: 6 digits, 10 min, 5 attempts, 15 min lock, 3 requests/hour; the code lives only in the fast store, hashed.
- [LOCAL] Devices capped at 10 per user (oldest evicted) → bounds fan-out and abuse.
- [LOCAL] Unsubscribe tokens never expire (old mail must keep working) but are HMAC-bound to (user, category) with a dedicated key.
- [LOCAL] Early provider callbacks are retried for 10 minutes → covers the race with our own timeline write.
- [LOCAL] Stale maximum ages: default 24 h, reset 30 min, OTP 10 min, outbid/chat/marketing 1 h.
- [LOCAL] Marketing fan-out walks followers in pages of 1,000 and is idempotent per (event, user, channel).
- [LOCAL] Inbox title ≤ 120, body ≤ 500, link relative → push payload limits and open-redirect safety.
- [LOCAL] `GET /preferences` adds `mandatoryChannels` per category (additive) → lets the UI show locked cells.
- [LOCAL] Time zones are validated at write time; an unknown zone read from storage falls back to UTC with a warning counter.
- [LOCAL] Quiet hours must be both set or both null; equal values are rejected (`quiet_hours_invalid`) instead of silently disabling.
