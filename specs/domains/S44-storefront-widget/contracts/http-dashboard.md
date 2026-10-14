# Contract: dashboard API (core, prefix `/api/shops/:shopId/widget`)

Auth: session or bearer, `ShopScoped('widget.manage')` (OWNER, ADMIN) on **every** route including reads. Cookie-authenticated mutations require S01's CSRF check (`403 csrf_invalid`). Rate limit `widget.manage.shop` (60/min, fail-closed) on mutations. Every site lookup: `WHERE id = :siteId AND "shopId" = :shopId`; foreign and unknown IDs are the same `404 widget_site_not_found`. Schemas live in `packages/contracts/src/developer-platform/widget.ts`.

| Route | Body / query | Success | Errors |
|---|---|---|---|
| `POST sites` | `{name?, origins[1..10], featuredProductIds?[≤12]}` (whitelisted) | `201 WidgetSiteCreatedDto` (secret shown once) | `422 origin_invalid {origin, reason}`, `422 site_limit_reached`, `422 featured_product_invalid`, `400` validation |
| `GET sites?limit&cursor` | keyset | `200 {items: WidgetSiteDto[], nextCursor}` | |
| `GET sites/:siteId` | | `200 WidgetSiteDto` | `404 widget_site_not_found` |
| `PATCH sites/:siteId` | `{name?, allowedOrigins?, featuredProductIds?, theme?, expectedVersion}` | `200 WidgetSiteDto` (version +1) | `409 site_version_conflict`, `422 origin_invalid`, `422 featured_product_invalid`, `400 validation_failed` (theme errors, AS-04) |
| `POST sites/:siteId/rotate-secret` | `{overlapHours?: 0..72 (default 24)}` | `201 {identitySecret, previousSecretExpiresAt}` | `409 rotation_in_progress` |
| `POST sites/:siteId/expire-previous-secret` | — | `200 WidgetSiteDto` | `404` |
| `PUT sites/:siteId/kill-switch` | `{on: boolean}` | `200 WidgetSiteDto` (idempotent; a real change bumps `version` +1 and writes history+event, a repeat changes nothing, AS-39/AS-40) | `400` malformed body |
| `DELETE sites/:siteId` | — | `204` (history removed, slot freed) | `404` |
| `GET sites/:siteId/history?limit&cursor` | keyset | `200 {items: [{id, change, from, to, actorId, at}], nextCursor}` | |

Role/identity matrix (AS-09): OWNER/ADMIN allowed; STAFF/VIEWER `403 permission_denied`; non-member `404 shop_not_found`; anonymous `401`; suspended shop `403 shop_suspended` and offboarding `409 shop_offboarding` for write routes.

`WidgetSiteDto = {id, shopId, name, publishableKey, allowedOrigins, featuredProductIds, theme, killSwitch, hasPreviousSecret, previousSecretExpiresAt, version, createdAt, updatedAt}`; `WidgetSiteCreatedDto = WidgetSiteDto & {identitySecret}`. The sealed secret columns never appear.

Origin rejection reasons (closed list, AS-02): `not_https`, `not_an_origin`, `userinfo`, `wildcard`, `ip_literal`, `localhost`, `single_label_host`, `trailing_dot`, `malformed`, `bad_port`.

Preflight (`OPTIONS`) on the public routes with an unknown or malformed key answers `403 origin_not_allowed` (AS-18), not `404`.
