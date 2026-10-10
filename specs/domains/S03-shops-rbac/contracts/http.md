# Contract: HTTP of S03 (`/api`, problem+json errors)

Schemas live in `packages/contracts/src/tenancy/` (`shopSchema`, `shopListItemSchema`, `shopMemberSchema`, `shopInviteSchema`, `shopSsoConfigSchema`, `shopSsoLookupSchema`, `shopExportSchema`, `shopRolesSchema`, `shopDirectorySchema`, `pageSchema(item)` = `{items, nextCursor}`). Bodies are strict: unknown fields → `400 validation_failed`. Error body: `{type, title, status, code, requestId}` (FR-100); any 5xx is generic. Answer order on shop routes: `401 invalid_token` → `404 shop_not_found` → `403 permission_denied` → status gate (`403 shop_suspended` / `409 shop_offboarding`). Shop resolved from the path `:shopId` or `X-Shop-Id`; both present and different → `400 shop_mismatch`; never from the body.

| Route | Permission / guard | Success | Errors (besides 400/401/404/429) |
|---|---|---|---|
| `POST /shops {name, slug, region?}` | authenticated; `tenancy.shop-create.user` | `201 shopSchema` | `409 slug_taken`, `409 shop_limit_reached`, `422 slug_reserved`, `422 region_not_allowed` |
| `GET /shops/mine?limit&cursor` | authenticated | `200 page<{id,name,slug,plan,status,role}>` | `400` bad cursor / limit > 100 |
| `GET /shops/:shopId` | `shop.read` | `200 shopSchema + myRole + myPermissions` | |
| `PATCH /shops/:shopId {name}` | `shop.manage` | `200 shopSchema` | `403 permission_denied`, `403 shop_suspended`, `409 shop_offboarding` |
| `GET /shops/:shopId/members` | `members.read` | `200 page<{userId,email\|null,role,source,joinedAt}>` | |
| `PATCH /shops/:shopId/members/:userId {role}` | `members.manage` + `canManage` | `204` (no-op `204`, no event) | `403 insufficient_role`, `404 member_not_found`, `409 last_owner`, `503 serialization_failure` (+`Retry-After`) |
| `DELETE /shops/:shopId/members/:userId` | `members.manage` + `canManage`; self always allowed | `204` | same as above |
| `POST /shops/:shopId/invites {email, role}` | `members.manage`; `tenancy.invite.shop` | `201 shopInviteSchema` (no token/link) | `403 insufficient_role` (ADMIN invites ADMIN), `409 already_member`, `409 invite_pending`, `409 seat_limit_reached` |
| `GET /shops/:shopId/invites?status&limit&cursor` | `members.manage` | `200 page<shopInviteSchema>` | |
| `POST /shops/:shopId/invites/:inviteId/resend` | `members.manage` | `200 shopInviteSchema` | `404 invite_not_found`, `409 invalid_transition` |
| `DELETE /shops/:shopId/invites/:inviteId` | `members.manage` | `204` (repeat `204`) | `404 invite_not_found`, `409 invalid_transition` |
| `POST /shop-invites/accept {token ≤128}` | authenticated; `tenancy.invite-accept.ip/.user` | `201 {shopId, role}` or `200 {shopId, role, alreadyMember:true}` | uniform `404 invite_not_found` |
| `PUT /shops/:shopId/sso {issuer, clientId, clientSecret?≤512, defaultRole?}` | `sso.manage` (OWNER) | `200 shopSsoConfigSchema` | `422 sso_issuer_invalid`, `422 sso_issuer_mismatch`, `422 sso_issuer_unreachable` |
| `GET /shops/:shopId/sso` | `sso.manage` | `200 shopSsoConfigSchema` (no secret) | `404 sso_not_configured` |
| `DELETE /shops/:shopId/sso` | `sso.manage` | `204` (repeat `204`) | |
| `GET /shops/by-slug/:slug/sso` | anonymous; `tenancy.sso-lookup.ip` | `200 {providerId, displayName}` | identical `404` for every non-SSO case |
| `GET /shops/:shopId/export` | `shop.export` (OWNER) | `200 shopExportSchema`, `Cache-Control: no-store` | works in `SUSPENDED`/`DELETING` |
| `POST /shops/:shopId/offboarding {confirmSlug}` | `shop.delete` | `200 {status:'DELETING', purgeAt}` (repeat same) | `422 confirmation_mismatch` |
| `DELETE /shops/:shopId/offboarding` | `shop.delete` | `200 {status:'ACTIVE'}` | `409 invalid_transition` |
| `GET /shop-roles` | authenticated | `200 shopRolesSchema` `{roles, permissions}` | |
| `POST /admin/shops/:shopId/suspend {reason}` | platform `ADMIN` + `Firewall({sensitive:true})` | `200 {id,status}` | `409 invalid_transition` |
| `POST /admin/shops/:shopId/reinstate {reason}` | same | `200 {id,status}` | `409 invalid_transition` |
| `GET /admin/shops/:shopId/directory` | same | `200 shopDirectorySchema` | |
| `PUT /admin/shops/:shopId/directory {cell, region, expectedVersion, reason}` | same | `200 {shopId,cell,region,version}` | `409 stale_version`, `422 unknown_cell`, `422 region_not_allowed` |
| `GET /batch/shops?ids=a,b` | anonymous | `200 ({id,name,slug}\|null)[]` in request order, `Cache-Control: public, max-age=30` | `400` > 100 ids / malformed |

Permission matrix (FR-020), served by `GET /shop-roles`:

| Permission | OWNER | ADMIN | STAFF | VIEWER |
|---|---|---|---|---|
| `shop.read`, `members.read`, `products.read`, `orders.read` | ✔ | ✔ | ✔ | ✔ |
| `products.write`, `orders.manage` | ✔ | ✔ | ✔ | — |
| `shop.manage`, `members.manage`, `payouts.read`, `api-keys.manage`, `webhooks.manage`, `integrations.manage` | ✔ | ✔ | — | — |
| `shop.delete`, `shop.export`, `billing.manage`, `sso.manage` | ✔ | — | — | — |

Sensitive set (always read from the database): `members.manage`, `sso.manage`, `shop.delete`, `shop.manage`, `shop.export`, `billing.manage`, `payouts.read`, `api-keys.manage`, `webhooks.manage`.

Status gate: `SUSPENDED` allows `shop.read`, `members.read`, `shop.export`; `DELETING` additionally `shop.delete`; `DELETED` is `404`.

Rate-limit policies (S50, fail-closed): `tenancy.shop-create.user` 5/h per user; `tenancy.invite.shop` 20/h per shop; `tenancy.invite-accept.user` 10 failures/15 min per user (enforced from code, failures only); `tenancy.invite-accept.ip` 30/min; `tenancy.sso-lookup.ip` 30/min; `tenancy.shop-write.shop` 120/min per shop on mutations.
