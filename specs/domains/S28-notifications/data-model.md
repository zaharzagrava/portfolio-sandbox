# Data model: S28 — Notification routing (domain `notifications`)

Owned tables (registry `db/ownership.ts:158-162`): `NotificationPreference`, `NotificationSettings`, `NotificationSuppression`, `PushDevice` (all `domain:notifications`). No new Postgres table. Inbox and delivery timeline stay in the wide-column store; counters, windows, markers and codes in Redis. Nothing here joins or references another domain's table (IX.4); `userId` / `shopId` are plain ids.

## Postgres (expand only, III.11)

| Table | Change | Notes |
|---|---|---|
| `NotificationSettings` | **add** `phoneVerifiedAt timestamptz NULL` | migration with `SET lock_timeout='3s'`, `ADD COLUMN IF NOT EXISTS`, no default, no rewrite. Contract step: none. Writing a different `phone` nulls it in the same statement. |
| `NotificationSettings` | **add** CHECK `(quietStart IS NULL) = (quietEnd IS NULL)` as `NOT VALID`, then `VALIDATE` in a second migration after a backfill that nulls half-set rows | stops the silent never-applies state (G-25); API validation is the first line, the constraint the store-level one (III.6). |
| `PushDevice` | **add** unique index `(userId, tokenHash)` … see below; **add** `tokenHash char(64)` (SHA-256 of the token), keep `token` | the token stays a column (sending needs it) but is never returned, logged, or addressed in a URL. Existing unique on `token` stays (a token belongs to exactly one user: "moved to the latest registering user" = upsert on `token`). Index `(userId, lastSeenAt)` for the 10-device cap eviction. `CREATE INDEX CONCURRENTLY` in its own migration. |
| `NotificationSuppression` | normalize: unique `(channel, address)` already assumed | a one-off data fix lower-cases and trims existing addresses before the code starts normalizing; resumable script, no schema change. |
| `NotificationPreference` | none | stored value = explicit override of the default. |

Accessed only through repository ports (below); no raw `Sequelize` in `application/`.

## Entities and validation

- **NotificationType** (static catalog, `domain/catalog.ts`): `{id, category, line: 'transactional'|'marketing', defaultChannels, mandatory, recipient: user|shopOwners|address|followers|…, inbox: boolean, maxAgeMs | 'until:<field>', link(data), templates{locale→{subject?,title,body}}}`. Catalog invariants checked by a unit spec: every default channel is in the channel list, every mandatory type has no unsubscribe, every type has `en` and `uk`, category ∈ the 13.
- **NotificationRequest** (`domain/types.ts`): `{type, recipient: {kind:'user', userId}|{kind:'address', email}, data, sourceId, occurredAt, sourceVersion?, family?, aggregateId?}`. `dedupe identity = sourceId|recipientKey|channel`.
- **RecipientView**: `{userId, email|null, phone|null, phoneVerified, locale, timezone, quietStart|null, quietEnd|null, overrides: Map<category|channel, boolean>, devices[]}`.
- **Settings** (write): timezone ∈ IANA (`Intl.supportedValuesOf('timeZone')` ∪ `UTC`), locale ∈ {`en`,`uk`}, `quietStart`/`quietEnd` `HH:MM` 24 h both-or-neither and not equal, `phone` E.164. Unknown stored zone → UTC + `notifications_timezone_fallback_total`.
- **Preference** (write): `(category, channel, enabled)`; `channel=sms && enabled` needs `phoneVerifiedAt` (`422 phone_not_verified`); mandatory cells are reported in `mandatoryChannels` and cannot be turned off for the mandatory types only (the category cell stays editable for the non-mandatory types of the category).
- **Device**: `{id uuid, userId, platform ∈ ios|android|web, token, lastSeenAt}`; ≤ 10 per user (oldest `lastSeenAt` evicted in the same `TransactionRunner.run`).
- **Suppression**: `(channel, address, reason ∈ bounce|complaint|stop|invalid_token|manual, createdAt)`, address normalized (e-mail trim+lowercase, phone E.164).

## Delivery status (pure, `domain/delivery-status.ts`)

```text
rank (higher wins, equal keeps the first):
queued 0 < delayed 1 < sent 2 < delivered 3 < bounced 4 < complained 5
pre-send terminals (rank 4, reachable only from queued/delayed): suppressed, capped, skipped, expired
failed (rank 4, reachable from queued/delayed/sent)
```
Rule: `next = rank(incoming) > rank(current) ? incoming : current`; `complained` outranks `bounced`/`delivered`; `delivered` never overwrites `complained|bounced|failed`; terminal pre-send states (`capped|skipped|expired|suppressed`) never move to `sent`. Property test: for any sequence the status never has a lower rank than a previous one.

## Wide-column store

**`notification_inbox`** (existing, expand): partition `(userId, bucket)` with bucket = `YYYYMM` of `eventTime`; clustering `(eventTime desc, id desc)`; columns `type, category, title, body, link, read boolean, arrivedAt timestamp (new), createdAt`; row TTL 15,552,000 s (180 days). `ALTER TABLE … ADD arrivedAt` (nullable; missing = `createdAt` when comparing). Insert is `IF NOT EXISTS` (LWT) keyed by deterministic `id`. Mark read is `UPDATE … SET read = true IF read = false`. Mark-all keeps a watermark in `notification_inbox_state(userId, readAllBefore timestamp)`.

**`notification_delivery`** (existing timeline, expand): partition `deliveryId`; rows `(at, status, provider, providerMessageId, detail, failover boolean)`; a summary row with latest status for precedence; secondary lookup table `notification_delivery_by_provider(provider, providerMessageId → deliveryId)` for callbacks (TTL 30 days). Detail never holds a body, address or token.

## Redis keys (all with TTL; prefix `notif:`; instance without `allkeys-*` eviction, III.9)

| Key | Value | TTL | Purpose |
|---|---|---|---|
| `done:<identity>` | `1` | 7 d | routing shortcut only |
| `ver:<family>:<aggregateId>` | max version | 7 d | out-of-order guard (script) |
| `cap:<userId>:<channel>` | zset deliveryId by admit time | window + 1 h | rolling cap |
| `cap:dec:<deliveryId>` | `admit|reject` | 7 d | final cap decision |
| `unread:<userId>` | integer | 400 d | counter (derived) |
| `unread:dirty` | zset userId by time | — (swept every 5 min) | crash repair |
| `claim:<deliveryId>` | worker id | 90 s | atomic send claim |
| `sent:<deliveryId>` | provider message id | 7 d | never hand to a provider twice |
| `otp:<userId>`, `otp:att:<userId>`, `otp:lock:<userId>` | HMAC / count / flag | 10 min / 15 min / 15 min | phone verification |
| `rv:<userId>` (S52 shared tier, `l1:'never'`) | recipient view | 5 min | invalidated on write |

## State transitions

- Delivery: `queued → (delayed →) sent → delivered`; `sent → bounced|complained|failed`; pre-send exits `capped|suppressed|skipped|expired`; `queued|delayed → failed(exhausted)`. Conditional updates on the summary row (`IF rank < :rank`), no history rewrite (III.7 spirit, store-appropriate).
- Inbox item: `unread → read` once (LWT).
- Phone: `unverified → code_requested → verified`; `locked` for 15 min after 5 failures.

## Ports (in `domain/ports.ts`, adapters in `infra/`)

`PreferenceRepository`, `SettingsRepository`, `DeviceRepository`, `SuppressionRepository`, `InboxStore`, `DeliveryTimelineStore`, `CounterStore` (unread, dirty), `CapStore`, `DedupeStore`, `VersionGuardStore`, `ClaimStore`, `OtpStore`, `RecipientDirectory` (wraps `UserDirectoryService` + `MembershipQueryService`), `FollowerAudience` (R-5), `RealtimeNotifier` (wraps `RealtimePublisher`), `DeliveryLineProducer`, `CallbackQueue`, `SendBudget` (wraps S50), `WakeScheduler` (wraps S49), `ProviderChain` (existing `provider-ports.ts`), `Clock`.
