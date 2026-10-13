# Contract: share-link HTTP API (global prefix `/api`)

Schemas live in `packages/contracts/src/marketing/share-links.ts` and are used by the controllers and the e2e specs (FR-105). Errors are `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`, `requestId`); the machine code is `type`.

## Schemas

| Name | Shape |
|---|---|
| `createShortLinkRequestSchema` | strict `{destination: string (≤ 2048, absolute URL, no whitespace/control chars), alias?: string, ttlDays?: integer 1–3650}` |
| `updateShortLinkRequestSchema` | strict `{destination}` (≥ 1 property; anything else is unknown) |
| `shortLinkSchema` | `{code, shortUrl, destination, status: "ACTIVE"\|"DISABLED", kind: "generated"\|"custom", createdAt, updatedAt, expiresAt: string\|null, disabledAt?}` (no owner, no store key) |
| `shortLinkPageSchema` | `{items: shortLink[], nextCursor: string\|null}` |
| `linkStatsSchema` | `{code, range: "24h"\|"7d"\|"30d", from, to, bucket: "minute"\|"hour"\|"day", total: number, series: [{start, clicks: number}], countries: [{country, clicks: number}] (≤ 10)}` |
| `linkClickedEventSchema` | see `events.md` |

## Endpoints

| Route | Auth | Success | Errors |
|---|---|---|---|
| `POST /links` | user; header `Idempotency-Key` (8–128 chars; platform charset `[A-Za-z0-9_-]`) | `201 shortLink`, `Location: /api/links/<code>`; replay `201` + `Idempotency-Replayed: true` | `400 validation_failed` (field named; includes a missing or short/long key), `401`, `409 alias_taken`, `409 idempotency_in_flight`, `422 destination_not_allowed`, `destination_blocked`, `alias_reserved`, `link_limit_reached`, `idempotency_key_reuse`, `idempotency_key_invalid` (key characters), `429` + `Retry-After` (profile `share-link.create`), `503 service_unavailable`, `code_generation_failed`, `destination_check_unavailable`, `rate_limiter_unavailable` |
| `GET /links?limit&cursor` | user | `200 shortLinkPage`; `limit` 1–100, default 20 | `400 validation_failed`, `400 invalid_cursor`, `401` |
| `PATCH /links/:code` | user, owner | `200 shortLink` | `400`, `401`, `404 link_not_found`, `409 link_not_active`, `422 destination_not_allowed\|destination_blocked`, `503` |
| `POST /links/:code/disable` | user, owner | `200 shortLink` (`status: DISABLED`, `disabledAt`) | `401`, `404`, `409 link_not_active` |
| `GET /links/:code/stats?range` | user, owner | `200 linkStats` | `400`, `401`, `404`, `503` |
| `GET /l/:code` | public | `302` | `404 link_not_found`, `410 link_gone`, `503` + `Retry-After: 5` |
| `HEAD /l/:code` | public | same status and headers as `GET`, no click | same |
| other methods on `/l/:code` | public | — | `405` |

## Redirect headers

| Case | Headers |
|---|---|
| `302` | `Location: <destination with ref=<code> before the fragment>`, `Cache-Control: public, max-age=0, s-maxage=10`, no `Set-Cookie`, empty body |
| `410 link_gone` (expired, disabled, destination no longer allowed) | `Cache-Control: public, s-maxage=60`, identical bodies |
| `404 link_not_found` (unknown or malformed) | `Cache-Control: no-store`, identical bodies |
| `503` | `Retry-After: 5` |

Edge credential request headers (origin only): `x-edge-click-recorded: 1` honoured only with `x-edge-credential` equal to `share_link_edge_secret` (constant-time compare); otherwise ignored.

## Breaking changes against today (all from `questions.md` BREAKING)

Create requires `Idempotency-Key`; response drops `ownerId`/`expiresAtEpoch`, gains `status/kind/updatedAt/expiresAt`, `201` + `Location`; `GET /links` is a page object; https only; alias lower-case 4–32 (`400` for format); expired → `410`; redirect `Cache-Control` adds `max-age=0`; stats shape; new `PATCH` and `disable` routes; rate-limit profile `share-link.create`. Known consumers of the old shapes: none in `packages/web` (W02 not built; **Check** `grep -r "api/links" packages/web` in T01).

## Barrel (`@app/domains/marketing`, share-link part)

`ShareLinksModule`, `ShareLinksWorkerModule`, `ShareLinksProjectorModule`, `LinkAttributionService`, `TooManyCodesError`, `AttributionUnavailableError`, DTO types, `linkClickedEventSchema`. `LinkClicksProjector` and `ShareLinkService` are not exported.

## R1 export

`LinkAttributionService.resolveAttributions(codes: string[]): Promise<Record<string, {code: string; ownerId: string; status: 'ACTIVE'|'EXPIRED'|'DISABLED'}>>` — ≤ 100 codes (`TooManyCodesError`), unknown/malformed omitted, one `BatchGetItem`, failure → `AttributionUnavailableError`.
