# Contract: HTTP — `/api/notifications/*`

Schemas live in `packages/contracts/src/notifications/` (new files `http.ts`; `index.ts` re-exports; `src/index.ts` re-exports the folder). Every e2e response is parsed with the schema named here (VII.6). Errors are `application/problem+json` from the global filter (`type`, `title`, `status`, `detail`, `instance`, `requestId`) with a stable `code`. The principal always comes from the session (`@User()`), never from the request. Every route except unsubscribe and provider callbacks has `Firewall()`.

| Route | Request schema | Response schema | Errors | Policy (S50, `definePolicies` in `rate-limit-policies.ts`) |
|---|---|---|---|---|
| `GET /notifications?limit&cursor` | `listNotificationsQuerySchema` (`limit` int 1..50 default 20, `cursor` opaque ≤ 512) | `notificationPageSchema` = `{items: notificationItemSchema[], nextCursor: string \| null}`; item `{id, type, category, title, body, link, read, createdAt}` | `400 validation_failed`, `400 invalid_cursor`, `401` | `notifications.read.user` |
| `GET /notifications/unread-count` | — | `unreadCountSchema` `{unread: int 0..1000}` | `401` | `notifications.read.user` |
| `POST /notifications/read` | `markReadRequestSchema` = exactly one of `{ids: uuid-shaped[1..100]}` or `{all: true}` | `unreadCountSchema` | `400 validation_failed` (garbage id, both keys, neither, > 100, duplicates collapse), `401` | `notifications.write.user` |
| `GET /notifications/preferences` | — | `notificationPreferencesSchema` `{settings: {timezone, locale, quietStart, quietEnd, phone (masked\|null), phoneVerified}, preferences: {category, channels: {email, sms, push, inapp}, mandatoryChannels: channel[]}[]}` | `401` | `notifications.read.user` |
| `PUT /notifications/preferences` | `updatePreferenceRequestSchema` `{category ∈ 13, channel ∈ 4, enabled}` | same as GET | `400 validation_failed`, `401`, `422 phone_not_verified` | `notifications.write.user` |
| `PUT /notifications/settings` | `updateSettingsRequestSchema` `{timezone?, locale?, quietStart?, quietEnd?, phone?}` (null clears) | same as GET | `400 validation_failed` (zone, locale, `HH:MM`, E.164), `422 quiet_hours_incomplete`, `422 quiet_hours_invalid`, `401`, `429` | `notifications.write.user` |
| `POST /notifications/settings/phone/code` | — | `202 {}` | `401`, `422 phone_missing`, `429` (`code: rate_limited`) | `notifications.phone-code.user` (3/h, fail closed) |
| `POST /notifications/settings/phone/verify` | `phoneVerifyRequestSchema` `{code: /^\d{6}$/}` | same as GET | `422 code_invalid {attemptsLeft}`, `422 code_expired`, `422 code_not_requested`, `422 phone_unreachable`, `429 verification_locked`, `401` | `notifications.phone-verify.user` (5 failures/15 min, fail closed) |
| `GET /notifications/devices` | — | `{items: deviceSchema[]}`; `deviceSchema` `{id, platform, lastSeenAt}` (no token) | `401` | `notifications.read.user` |
| `POST /notifications/devices` | `registerDeviceRequestSchema` `{token ≤ 4096, platform ∈ ios\|android\|web}` | `201` new / `200` known token → `deviceSchema` | `400 validation_failed`, `401` | `notifications.write.user` |
| `DELETE /notifications/devices/:deviceId` | param uuid | `204` | `404 device_not_found` (also for another user's id), `400 validation_failed`, `401` | `notifications.write.user` |
| `GET /notifications/unsubscribe?token` | `unsubscribeQuerySchema` | `{category}` (describes only, no state change) | `400 invalid_unsubscribe_token` | `notifications.unsubscribe.ip` (30/min, fail closed) |
| `POST /notifications/unsubscribe?token` | same | `{unsubscribed: category}` | `400 invalid_unsubscribe_token` | same |
| `POST /notifications/webhooks/ses` | raw body (signature) | `200` | `401` bad signature/topic/cert host, `400` non-JSON (outer or inner), `401` timestamp outside 5 min | `notifications.webhook.ip` (fail open) |
| `POST /notifications/webhooks/twilio` | raw form body (signature) | `200` | `401` bad/absent signature or token not configured, `400` malformed | `notifications.webhook.ip` |

## Behaviour notes (binding for tasks)

- Controllers do three things only (II.1): validated DTO (zod pipe built from the contract schema), one application call, response DTO. The existing class-validator DTOs and ad-hoc `BadRequestException`s are deleted.
- Rate-limit answers adopt S50: `429` with `Retry-After` and structured `RateLimit` / `RateLimit-Policy` headers; `503 rate_limiter_unavailable` for a fail-closed policy with the limiter down; `422 rate_limit_cost_exceeded` is not produced here (all costs are 1) but is documented for clients.
- Unsubscribe token: `base64url(userId|category|v1).HMAC(notification_secret)`, no expiry, bound to (user, category); bad shape, bad MAC and unknown category answer the same `400` with the same body.
- `GET /devices` and `POST /devices` never return the token. The old `POST /devices` → `204` and `DELETE /devices/:token` are removed (BREAKING, `questions.md`); because the web client is the only caller (`packages/web`), the same change updates W03 callers or lists them in the sibling bullets.
- Realtime: event `notification` `{id, type, category, title, body, link, unread, createdAt}` on the owner-only topic `user:<userId>`; `unread` is the item's own flag (`true`), no `unreadCount` (W03 re-reads the count on focus and reconnect).
- E-mail headers (provider contract, tested through the provider spy): non-mandatory types carry `List-Unsubscribe: <https://…/api/notifications/unsubscribe?token=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; mandatory types carry neither.
