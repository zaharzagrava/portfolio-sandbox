---
id: S03
title: Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S53, S50, S51, S54]
concepts: [tenant-shop-rbac, problem-json-errors, request-context, outbox-task-queue, rate-limit-policy, realtime-topic-stream, transaction-runner, cache-layers]
models: []
scope:
  - packages/backend/libs/domains/tenancy/**
---
# S03 - Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
## Purpose
A shop is the tenant of the marketplace: a seller organisation with a team, a plan, a verification status and a place in the infrastructure. This capability decides who may do what inside a shop. It makes sure one shop never sees or disturbs another, as described in {{concept:tenant-shop-rbac}}. Sellers, shop staff and other capabilities need it to create shops, manage the team, invite people and read shop data.

## Entry points
- `POST /shops`: a signed-in user creates a shop and becomes its `OWNER`. [code: packages/backend/libs/domains/tenancy/api/shop.controller.ts#ShopController]
- `GET /shops/mine`: lists the caller's shops with their role, cursor-paginated. [code: packages/backend/libs/domains/tenancy/api/shop.controller.ts#ShopController]
- `GET /shops/:shopId`: a member reads the shop, `myRole` and `myPermissions`.
- `PATCH /shops/:shopId`: a member with `shop.manage` renames the shop.
- `GET /shops/:shopId/members`: lists members.
- `PATCH /shops/:shopId/members/:userId`: changes a member's role (`204`). [code: packages/backend/libs/domains/tenancy/api/members.controller.ts#MembersController]
- `DELETE /shops/:shopId/members/:userId`: removes a member, or a member leaves.
- `POST /shops/:shopId/invites`: creates an invite. [code: packages/backend/libs/domains/tenancy/api/invites.controller.ts#InvitesController]
- `GET /shops/:shopId/invites`: lists invites.
- `POST /shops/:shopId/invites/:inviteId/resend`: renews an invite.
- `DELETE /shops/:shopId/invites/:inviteId`: revokes an invite.
- `POST /shop-invites/accept`: the invited person accepts with a token.
- `PUT /shops/:shopId/sso`: an owner configures the shop's identity provider. [code: packages/backend/libs/domains/tenancy/api/sso.controller.ts#SsoController]
- `GET /shops/by-slug/:slug/sso`: anonymous lookup whether a shop has company sign-in.
- `GET /shop-roles`: returns the role and permission matrix. [code: packages/backend/libs/domains/tenancy/api/shop-roles.controller.ts#ShopRolesController]
- `GET /batch/shops`: anonymous batch read of `{id, name, slug}` for the BFF. [code: packages/backend/libs/domains/tenancy/api/shop-batch-read.controller.ts#ShopBatchReadController]
- Queue `tenancy-invite-requested`: carries the invite message to the notification capability.
- Topic `shop:<shopId>:live`: realtime topic admitted only to members. [code: packages/backend/libs/domains/tenancy/api/realtime-topics.ts#ShopTopics]
- Exported services: `ShopAccessService`, `ShopQueryService`, `MembershipQueryService`, `ShopProvisioningService`, `ShopCellService` for other capabilities.

## Rules
- **S03.R-01** A non-member, an unknown shop, a malformed identifier and a deleted shop MUST all answer the same `404 shop_not_found`. [proof: S03 AS-09, S03 AS-15] [code: packages/backend/libs/domains/tenancy/domain/errors.ts#Domain_ShopNotFoundError]
- **S03.R-02** Every endpoint except the public ones MUST answer `401 invalid_token` without credentials. [proof: S03 AS-05]
- **S03.R-03** The shop MUST come from the path or the `X-Shop-Id` header, never from the body. A path and header that differ MUST answer `400 shop_mismatch`. [proof: S03 AS-10] [code: packages/backend/libs/domains/tenancy/api/shop.guard.ts#ShopGuard]
- **S03.R-04** Answers MUST follow this order: `401`, `404`, `403 permission_denied`, then the status gate. [proof: S03 AS-12]
- **S03.R-05** A `SUSPENDED` shop MUST allow only `shop.read`, `members.read` and `shop.export`, and refuse the rest with `403 shop_suspended`. [proof: S03 AS-12]
- **S03.R-06** The allowed permissions of each role MUST equal the matrix of FR-020. An unknown role or permission MUST be denied. [proof: S03 AS-11, S03 AS-16] [code: packages/backend/libs/domains/tenancy/domain/permissions.ts#ROLE_PERMISSIONS]
- **S03.R-07** The permissions of a lower role MUST be a subset of those of the adjacent higher role. [proof: S03 AS-17]
- **S03.R-08** Only an `OWNER` MAY assign, change or remove `OWNER` or `ADMIN`. An `ADMIN` MAY manage `STAFF` and `VIEWER` only. Violations MUST answer `403 insufficient_role`. [proof: S03 AS-18, S03 AS-19] [code: packages/backend/libs/domains/tenancy/domain/role-policy.ts#canManage]
- **S03.R-09** Every member MAY remove themselves, even without `members.manage`. [proof: S03 AS-25] [code: packages/backend/libs/domains/tenancy/domain/role-policy.ts#canLeave]
- **S03.R-10** A shop MUST always keep at least one `OWNER`; a change that removes the last one MUST answer `409 last_owner`, also under concurrent changes. [proof: S03 AS-22, S03 AS-23]
- **S03.R-11** After three serialization conflicts in a row, a change MUST answer `503 serialization_failure` with `Retry-After: 1` and change nothing. [proof: S03 AS-24]
- **S03.R-12** A user MUST own at most 10 shops, also under concurrent creates. [proof: S03 AS-04] [code: packages/backend/libs/domains/tenancy/domain/seat-policy.ts#MAX_OWNED_SHOPS]
- **S03.R-13** A slug MUST be 3 to 40 characters of `[a-z0-9-]`, without a leading or trailing hyphen; reserved handles answer `422 slug_reserved` and used slugs `409 slug_taken`. [proof: S03 AS-02, S03 AS-03] [code: packages/backend/libs/domains/tenancy/domain/slug-policy.ts#checkSlug]
- **S03.R-14** An invite token MUST be stored only as a digest, MUST be single-use, and MUST NOT appear in any API response. [proof: S03 AS-28, S03 AS-34, S03 AS-38] [code: packages/backend/libs/domains/tenancy/domain/invite-token.ts#digestInviteToken]
- **S03.R-15** Every failed invite acceptance (unknown, expired, revoked, used, wrong address, inactive shop) MUST answer the same `404 invite_not_found`. [proof: S03 AS-33]
- **S03.R-16** An invite MUST NOT grant `OWNER`. [proof: S03 AS-29]
- **S03.R-17** Seats used (members plus unexpired pending invites) MUST NOT exceed the plan limit: `STARTER` 5, `PRO` 25, `ENTERPRISE` 250. [proof: S03 AS-31] [code: packages/backend/libs/domains/tenancy/domain/seat-policy.ts#seatLimit]
- **S03.R-18** A shop MUST NOT create more than 20 invites per hour, and a user MUST NOT make more than 10 failed accepts in 15 minutes; both answer `429` with `Retry-After`. [proof: S03 AS-39] [code: packages/backend/libs/domains/tenancy/domain/tenancy-rate-policies.ts#tenancyRatePolicies]
- **S03.R-19** Tenancy tables MUST be unreadable without a tenant set, and the tenant setting MUST NOT leak between transactions on one connection. [proof: S03 AS-57, S03 AS-58]
- **S03.R-20** The cross-tenant bypass MUST accept only allowlisted reasons, and production start MUST fail if the database role has superuser or bypass rights. [proof: S03 AS-59, S03 AS-60] [code: packages/backend/libs/domains/tenancy/domain/cross-tenant-reason.ts#isCrossTenantReason]

## Behaviors
- **S03.B-01** Given a signed-in user and a free slug, when they `POST /shops`, then the answer is `201` with plan `STARTER`, status `ACTIVE`, verification `UNVERIFIED` and `payoutsEnabled` false. [proof: S03 AS-01]
- **S03.B-02** Given an 11th shop for one owner, when created, then `409 shop_limit_reached` and nothing is stored. [proof: S03 AS-04]
- **S03.B-03** Given a member, when they `GET /shops/:shopId`, then they receive the shop, `myRole` and `myPermissions`. [proof: S03 AS-06]
- **S03.B-04** Given a user in three shops, when they list `GET /shops/mine?limit=2`, then two items and an opaque `nextCursor` return, and the next page returns the third with `nextCursor: null`. [proof: S03 AS-07]
- **S03.B-05** Given a member with `shop.manage`, when the body carries `slug`, `plan` or `status`, then `400 validation_failed`. [proof: S03 AS-08]
- **S03.B-06** Given an owner, when they demote a member, then `204` and the target's cache entry is dropped. [proof: S03 AS-21, S03 AS-13]
- **S03.B-07** Given a member removed from a shop, when they subscribe to `shop:<shopId>:live`, then the subscription is refused. [proof: S03 AS-27]
- **S03.B-08** Given a member removed with source `sso`, when the removal commits, then their sessions are revoked with reason `shop_membership_removed`. [proof: S03 AS-26]
- **S03.B-09** Given a member with `members.manage`, when they invite `" New@Mail.com "` as `VIEWER`, then `201` returns the lower-cased address, a 7-day expiry and no token. [proof: S03 AS-28]
- **S03.B-10** Given an address that is a member or has a pending invite, when invited, then `409 already_member` or `409 invite_pending`. [proof: S03 AS-30]
- **S03.B-11** Given one valid token and two simultaneous accepts, then one `201` and one `404 invite_not_found`. [proof: S03 AS-34, S03 AS-32]
- **S03.B-12** Given an invitee who is already a member, when they accept, then `200` with `alreadyMember: true` and the role stays unchanged. [proof: S03 AS-35]
- **S03.B-13** Given a pending invite, when a manager revokes it, then `204` and the token stops working; a resend gives a fresh expiry and kills the old token. [proof: S03 AS-36, S03 AS-37]
- **S03.B-14** Given an anonymous caller, when they `GET /batch/shops?ids=…`, then an array in request order of `{id, name, slug}` or `null` for sandbox, suspended, deleting or deleted shops. [proof: S03 AS-80]
- **S03.B-15** Given an anonymous visitor, when they look up a shop slug for SSO, then the answer is `200` or an identical `404`. [proof: S03 AS-46]
- **S03.B-16** Given legacy sellers, when `ensureShopsForLegacySellers` runs twice, then each seller has exactly one shop and the second call creates nothing. [proof: S03 AS-62]
- **S03.B-17** Given a live shop, when `ensureSandboxShop` runs twice, then exactly one sandbox shop exists. [proof: S03 AS-63]
- **S03.B-18** Given a `billing.subscription_plan_changed` event with an older version, then the plan stays unchanged. [proof: S03 AS-73]

## Lifecycles
Shop status: `ACTIVE`, `SUSPENDED`, `DELETING`, `DELETED`. Allowed moves: `ACTIVE→SUSPENDED`, `SUSPENDED→ACTIVE`, `ACTIVE→DELETING`, `SUSPENDED→DELETING`, `DELETING→ACTIVE`, `DELETING→DELETED`. Every other pair is `invalid_transition`. [proof: S03 AS-64] [code: packages/backend/libs/domains/tenancy/domain/shop-status.ts#nextState]
Verification: `UNVERIFIED→PENDING`, `PENDING→VERIFIED` or `REJECTED`, `REJECTED→PENDING`; `VERIFIED` is final; `payoutsEnabled` is true only when `VERIFIED`. [proof: S03 AS-71] [code: packages/backend/libs/domains/tenancy/domain/verification-status.ts#applyVerification]
Invite: `pending`, `accepted`, `revoked`, `expired` (derived from time).

## Owns
- Tables: `Shop`, `ShopMembership`, `ShopInvite`, `ShopSsoConfig`, `ShopDirectory`, `ShopStatusHistory`.
- Queue: `tenancy-invite-requested`.
- Events: `tenancy.shop_created`, `tenancy.shop_updated`, `tenancy.shop_status_changed`, `tenancy.shop_verification_changed`, `tenancy.shop_plan_changed`, `tenancy.member_added`, `tenancy.member_role_changed`, `tenancy.member_removed`, `tenancy.invite_created`, `tenancy.shop_cell_moved`, `tenancy.shop_offboarding_started`, `tenancy.shop_offboarding_cancelled`, `tenancy.shop_deleted`. State changes and events commit in one transaction; a failed outbox append rolls back the change. [proof: S03 AS-78]
- Consumes: `billing.subscription_plan_changed`.
- Rate-limit policies: `tenancy.shop-create.user`, `tenancy.shop-write.shop`, `tenancy.invite.shop`, `tenancy.sso-lookup.ip`.
- Authorization cache: shared store, entries live at most 15 s (negative 10 s); sensitive permissions always read the database.

## Decisions
- Tenant resolution runs once per request, so every check, log line and event carries the same shop. [proof: S03 AS-14]
- Not-found answers are uniform so callers cannot probe which shops exist.
- The authorization cache is never the source of truth; writers delete entries after commit.
- The last-owner invariant is enforced by the store under serializable isolation with bounded retry.
- Tenancy reads user data only through the identity directory and writes no other domain's tables.
- Connection routing is fail-closed: an unknown cell gives `503 cell_unavailable`, never the pooled database.
- Row-level security is set per transaction, not per session.

## Known gaps
- No test carries a proof id for AS-12 status-gate details beyond those listed in rule R-05; the `DELETING` gate (`409 shop_offboarding`) is not tied to a rule here.
- Per-shop SSO: the controller states it is the pre-S03 behaviour. Only `PUT /shops/:shopId/sso` and the public lookup are built. Reading, deleting, discovery checks, SSRF guard and sealed secrets (AS-40 to AS-45) have no test.
- SSO provisioning from `identity.federated_identity_linked` (AS-47 to AS-50) has no test and no route or consumer in the facts.
- Cells (AS-51 to AS-56): admin directory move, connection routing, bulkhead and cache lifetime have no test and no route.
- Admin suspend and reinstate (AS-65), offboarding start and cancel (AS-66, AS-67), export (AS-68) and the purge job (AS-69, AS-70) have no route and no test in the facts.
- Verification events from `shop.onboarding_submitted`, `shop.verified`, `shop.rejected` (AS-72) have no test; only the state machine (AS-71) is covered.
- AS-27 and AS-83 realtime admission: only the removed-member case has a test (AS-27).
- AS-61 schema rules, AS-74 to AS-77 and AS-79, AS-81 are covered by tests but not summarised as separate rules here.
- Rules R-14 and R-18 are tied to tests only partly: the digest-only storage and the 429 limits come from AS-28 and AS-39 and are not checked separately.