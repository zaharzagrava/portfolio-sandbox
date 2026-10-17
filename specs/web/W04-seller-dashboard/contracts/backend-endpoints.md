# Backend endpoints used by W04

All paths are the browser's same-origin paths (`/api/...`); the forwarder strips `/api/` and attaches the session bearer (research R-02). "Exists" = a controller route was found on 2026-10-17 (`research.md` R-01). Schemas are in `packages/contracts/src`. Domain contract files of the owning specs (`specs/domains/<id>/contracts/*`) are the detail; this file lists what W04 sends and parses.

## New in this plan

### B-1 `GET /api/bff/seller/{shopId}/overview?days=7|30|90`

- Owner/place: `packages/backend/libs/composition/bff/seller/seller-overview.{controller,service}.ts`, registered in `bff.module.ts`; modelled on `orders/order-page.controller.ts`.
- Guards/policies: `CredentialsGuard`, `@RateLimit('bff.seller-overview.principal')` (add the policy in `rate-limit-policies.ts`), `ZodPipe` for `shopId` (UUID) and `days` (enum, default 30). Headers: `Cache-Control: private, no-store`. The request's abort signal is passed to upstream calls.
- Behaviour: reads the shop (tenancy `GET /shops/{shopId}` as the caller) first. Non-member / unknown / foreign → `404 shop_not_found`; shop read failing → `503 upstream_unavailable`; otherwise reads in parallel, each with its own timeout: stats (`GET /shops/{id}/stats?days=`), today (`…/dashboard/today`), rank (`…/rank`; upstream `404 not_ranked` → `{notRanked: true}`, not an error). A failed or timed-out section is `null` with `errors: [{section, code, retryable}]`. No database access, no business rule, no cache of per-user data.
- Response: `sellerOverviewResponseSchema`.
- e2e (`seller-overview.e2e-spec.ts`, real BFF module, upstream edge faked at the HTTP client): happy; `days=0|366|abc` → `400 validation_failed`; malformed id → `400`; no credentials → `401`; non-member `404` identical to unknown; each section failing alone yields the others intact; shop failing `503`; `not_ranked` → `{notRanked:true}`; response parses with the schema; no `Set-Cookie`.

### B-2 `packages/contracts/src/bff/seller-overview.ts`

```ts
sellerOverviewErrorSchema = z.object({ section: z.enum(['stats','today','rank']), code: z.string(), retryable: z.boolean() }).strict();
sellerOverviewResponseSchema = z.object({
  shop: shopSchema,
  stats: sellerStatsSchema.nullable(),
  today: dashboardTodaySchema.nullable(),
  rank: z.union([shopRankSchema, z.object({ notRanked: z.literal(true) }).strict()]).nullable(),
  errors: z.array(sellerOverviewErrorSchema),
}).strict();
```

Exported from `bff/index.ts`; a contract spec (like `w03-contracts.spec.ts`) proves the example bodies parse.

### B-3 Configuration

`PLATFORM_CURRENCY` (ISO 4217 code) and `PUBLIC_API_BASE_URL` (absolute URL) added to the web server config (`lib/config.ts` / `config-parse.ts`, server-only, parse-tested in `lib/config.test.ts`); documented in `.env.example`/README. They reach client components only as props (`currency`, `fractionDigits`, `apiBaseUrl`). Missing value: `PLATFORM_CURRENCY` → the product form's "Add product" is disabled with a problem alert (not a silent default); `PUBLIC_API_BASE_URL` → the "Using the API" example shows `https://<your-api-host>`.

### B-4 Shape checks (Phase 1, read-only unless a mismatch is found)

1. `GET /shops/{id}` always includes `myRole` and `myPermissions`; if so, make both required in `shopSchema` (R-10), else add them in tenancy.
2. `GET keys` and `GET logs` answer `{items, nextCursor}` and accept `limit`, `cursor`.
3. `GET /shops/{id}/orders` accepts `status`, `limit`, `cursor`; list the status values in `shopOrderStatusSchema` (W04 title-cases unknown values).
4. `GET /shop-roles` body equals `shopRolesSchema` (`{roles: {OWNER:[…],…}, permissions:[…]}`).
5. `GET /shops/mine` items carry `status`.

A mismatch is fixed in the owning domain (with its e2e) or written under `## Sibling-spec follow-ups` in `gaps.md` when the owner's spec must change.

### B-5 Audit

Every backend file edited by B-1..B-4 is grepped for `// S54 T037 audit`; a direct `sequelize.transaction` found there is migrated to `TransactionRunner.run` / `@Transactional` and the comment deleted. No new direct site.

## Consumed (exist)

| Area | Calls | Response schema | Notes |
|---|---|---|---|
| Shops | `GET /shops/mine?limit=50&cursor`; `POST /shops {name, slug}`; `GET /shops/{id}` | `shopListItemSchema` page; `shopSchema` | `409 slug_taken`, `422 slug_reserved`, `409 shop_limit_reached`, `429` |
| Products | `GET /shops/{id}/products?status&inStock&limit&cursor`; `GET …/products/{pid}`; `POST …/products`; `PATCH …/products/{pid} {expectedVersion,…}`; `POST …/archive`, `…/restore {expectedVersion}`; `GET …/products/search?q&limit&cursor` | `productPageSchema`, `productMemberSchema`, `shopProductSearchResponseSchema` | `version_conflict {currentVersion}`, `product_archived`, `invalid_transition`, `product_not_found`, `currency_not_supported` |
| Orders | `GET /shops/{id}/orders?status&limit&cursor` | `shopOrderPageSchema` | read-only |
| Keys | `GET/POST …/developers/keys`; `POST …/keys/{id}/rotate {overlapHours}`; `DELETE …/keys/{id}` | `apiKeyListSchema`, created/rotated payloads | `mfa_required`, `key_limit_reached`, `key_revoked`, `key_expired`, `key_already_rotating`, `resource_missing` |
| Version/logs/usage | `GET/PUT …/developers/api-version`; `GET …/logs?…`; `GET …/usage?days&livemode` | `apiVersionStateSchema`, `requestLogPageSchema`, `usageReportSchema` | `version_retired` |
| Webhooks | list/create/get/patch/delete; `POST …/{id}/enable|disable|rotate-secret|expire-previous-secret|ping`; `GET …/{id}/attempts`; `GET …/{id}/events/{eid}`; `POST …/events/{eid}/replay` + `Idempotency-Key`; `GET …/webhook-event-types` | `webhookEndpointPageSchema`, `webhookEndpointSchema`, `webhookAttemptPageSchema`, `webhookEventDetailSchema`, `webhookEventTypesResponseSchema` | codes in the spec's error catalogue |
| Team | `GET …/members`, `PATCH …/members/{uid} {role}`, `DELETE …/members/{uid}`; `GET/POST …/invites`, `POST …/invites/{id}/resend`, `DELETE …/invites/{id}`; `POST /shop-invites/accept {token}`; `GET /shop-roles` | `shopMemberSchema`, `shopInviteSchema`, `inviteAcceptedSchema`, `shopRolesSchema` | `insufficient_role`, `last_owner`, `seat_limit_reached`, `invite_pending`, `already_member`, `invite_not_found` |
| Stream | `GET /api/streams?topics=shop:{id}:live` (via the shared stream) | `liveDashboardFrameSchema` in `data` of the hub envelope | `resync`, `revoked`, final `401`/`403` |
| Refresh | `useRefreshSession()` after a shop opens | — | W01 |

## Phase 9 sources (read these files first; any mismatch becomes a `gaps.md` bullet)

F1 `specs/domains/S06-collab-editor/contracts/{http,collab-ws}.md` · F2 `S07-bulk-import/contracts/http-api.md` · F3 `S08-integrations/contracts/http-api.md`, `packages/contracts/src/catalog-sync/offline-sync.ts` · F4 `S12-order-export` contracts · F5 `S14`, `S15`, `S16` contracts (`contracts/http.md`) · F6 `S29-photos`, `S30-video` contracts · F7 `S36-sponsored-listings/contracts/ads-api.md` · F8 `S44-storefront-widget` contracts · F9 `S47-rag-help-center/contracts/knowledge-api.md`.
