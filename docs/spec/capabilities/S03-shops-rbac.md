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
- `GET /shops/:shopId/sso`, `DELETE /shops/:shopId/sso`: an owner reads the configuration (never the secret) or removes it.
- `GET /shops/by-slug/:slug/sso`: anonymous lookup whether a shop has company sign-in.
- `POST /shops/:shopId/offboarding`, `DELETE /shops/:shopId/offboarding`: an owner starts (with the slug as confirmation) or cancels closing the shop. [code: packages/backend/libs/domains/tenancy/api/offboarding.controller.ts#OffboardingController]
- `GET /shops/:shopId/export`: an owner downloads what tenancy holds about the shop.
- `POST /admin/shops/:shopId/suspend`, `POST /admin/shops/:shopId/reinstate`, `GET|PUT /admin/shops/:shopId/directory`: platform administrators with a sensitive session suspend, reinstate and move a shop between cells. [code: packages/backend/libs/domains/tenancy/api/admin-shops.controller.ts#AdminShopsController]
- Consumers: `identity.federated_identity_linked` (membership for company sign-ins), `shop.onboarding_submitted`, `shop.verified`, `shop.rejected` (verification), `billing.subscription_plan_changed` (plan).
- Jobs: `tenancy.purge-deleted-shops` (hourly), `tenancy.purge-expired-invites` (daily), `tenancy.reseal-sso-secrets` (daily, idempotent). [code: packages/backend/libs/domains/tenancy/infra/jobs/purge-shops.jobs.ts#PurgeShopsJobs]
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

- **S03.R-21** The issuer of a shop's identity provider MUST be an `https` URL on a public address whose discovery document, fetched once within 3 s outside any transaction, names the same issuer; otherwise `422 sso_issuer_invalid`, `sso_issuer_mismatch` or `sso_issuer_unreachable` and nothing is stored. Only an `OWNER` MAY configure it. [proof: S03 AS-40, S03 AS-41] [code: packages/backend/libs/domains/tenancy/infra/oidc-discovery.adapter.ts#OidcDiscoveryAdapter]
- **S03.R-22** The client secret MUST be stored sealed with the context `shop-sso:<shopId>`, MUST NOT appear in any response, and MUST be handed in plain form only to the sign-in registry at the moment a login resolves the provider; a disabled provider, a shop that is not `ACTIVE` and a sandbox shop MUST resolve as unknown. Removing the configuration MUST delete the row. [proof: S03 AS-40, S03 AS-44, S03 AS-45] [code: packages/backend/libs/domains/tenancy/application/shop-sso.service.ts#ShopSsoService]
- **S03.R-23** A user who signs in through a shop's provider MUST become a member with `source: sso` and the provider's default role once, only while SSO is enabled, the shop is `ACTIVE` and a seat is free; a member who exists keeps their role and a removed member MUST NOT be added again by a redelivered event. [proof: S03 AS-47, S03 AS-48, S03 AS-49] [code: packages/backend/libs/domains/tenancy/application/sso-provisioning.service.ts#SsoProvisioningService]
- **S03.R-24** Routing a shop to a database cell MUST fail closed: a cell the process has no connection for, cannot reach, or whose pool stays full for the acquire timeout (2 s) MUST answer `503 cell_unavailable` and MUST NOT use the pooled database; other shops stay unaffected. [proof: S03 AS-53, S03 AS-54] [code: packages/backend/libs/domains/tenancy/infra/tenant-connection.resolver.ts#TenantConnectionResolver]
- **S03.R-25** Only a platform `ADMIN` with a session that is not revoked MAY move a shop between cells; the move MUST be conditional on the directory version (`409 stale_version`) and name a configured cell (`422 unknown_cell`). The cell lookup is cached in the process for 5 minutes and dropped on a move. [proof: S03 AS-52, S03 AS-55] [code: packages/backend/libs/domains/tenancy/application/shop-cell.service.ts#ShopCellService]
- **S03.R-26** Only an `OWNER` MAY start or cancel offboarding, with the slug as confirmation (`422 confirmation_mismatch`); a repeat start MUST answer the same result without a second event; a suspended shop MUST NOT be closed through the API. [proof: S03 AS-66, S03 AS-67] [code: packages/backend/libs/domains/tenancy/application/shop-lifecycle.service.ts#ShopLifecycleService]
- **S03.R-27** The purge MUST run once per due shop in its own transaction and leave a tombstone (`DELETED`, name `[deleted]`, slug `deleted-<id>`) with no member, invite, SSO configuration, directory row or status history; it MUST publish `tenancy.member_removed` (reason `shop_deleted`) and `tenancy.shop_deleted` and end the sessions of former `sso` members. [proof: S03 AS-69] [code: packages/backend/libs/domains/tenancy/application/shop-lifecycle.service.ts#ShopLifecycleService]
- **S03.R-28** Verification status and `payoutsEnabled` MUST change only through the verification events and the machine of the lifecycle; the same event twice MUST change nothing, and a decision that arrives before the submission MUST leave the shop decided. [proof: S03 AS-72] [code: packages/backend/libs/domains/tenancy/application/verification.service.ts#VerificationService]

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
- **S03.B-19** Given an owner who sends `PUT /shops/:shopId/sso` without a secret for an existing configuration, then the stored secret is kept; a replay of the same body gives the same result. [proof: S03 AS-42]
- **S03.B-20** Given an owner of a shop with SSO, when they `GET /shops/:shopId/sso`, then they see issuer, client id, default role and `secretSet`, never the secret; before any configuration the answer is `404 sso_not_configured`. [proof: S03 AS-43]
- **S03.B-21** Given a member of a company who signs in through `shop:<shopId>`, then the new account has no e-mail address and is never linked to an existing account by address. [proof: S03 AS-50]
- **S03.B-22** Given a platform administrator, when they suspend an active shop, then status `SUSPENDED`, a history row with actor and reason, `tenancy.shop_status_changed` and a dropped provider cache follow; suspending a suspended shop or reinstating an active or closing one answers `409 invalid_transition`. [proof: S03 AS-65]
- **S03.B-23** Given an owner of a closing shop, when they `DELETE /shops/:shopId/offboarding`, then the shop is `ACTIVE` again with no `purgeAt` and `tenancy.shop_offboarding_cancelled` is published; on an active shop it answers `409 invalid_transition`. [proof: S03 AS-67]
- **S03.B-24** Given an owner, when they `GET /shops/:shopId/export`, then the answer carries the shop, members with addresses, invites and the SSO configuration without secrets, with `Cache-Control: no-store`, also while the shop is suspended or closing. [proof: S03 AS-68]
- **S03.B-25** Given a closing shop, when the purge job runs before `purgeAt`, then nothing changes; after it, the shop is a tombstone, the old slug can be registered again and the former owner gets `404`. [proof: S03 AS-69]
- **S03.B-26** Given a suspended or closing shop, then no invite is created, resent or accepted and no member is provisioned from a company sign-in. [proof: S03 AS-70]
- **S03.B-27** Given the daily invite purge, when invites are 30 days past expiry, revocation or acceptance, then only those are deleted together with their addresses. [proof: S03 AS-70]
- **S03.B-28** Given a new shop, then its directory row is `pooled` at version 1 in the default or requested allowed region, and the region changes only through the administrator's move. [proof: S03 AS-51, S03 AS-56]

## Lifecycles
Shop status: `ACTIVE`, `SUSPENDED`, `DELETING`, `DELETED`. Allowed moves: `ACTIVE→SUSPENDED`, `SUSPENDED→ACTIVE`, `ACTIVE→DELETING`, `SUSPENDED→DELETING`, `DELETING→ACTIVE`, `DELETING→DELETED`. Every other pair is `invalid_transition`. [proof: S03 AS-64] [code: packages/backend/libs/domains/tenancy/domain/shop-status.ts#nextState]
Verification: `UNVERIFIED→PENDING`, `PENDING→VERIFIED` or `REJECTED`, `REJECTED→PENDING`; `VERIFIED` is final; `payoutsEnabled` is true only when `VERIFIED`. [proof: S03 AS-71] [code: packages/backend/libs/domains/tenancy/domain/verification-status.ts#applyVerification]
Invite: `pending`, `accepted`, `revoked`, `expired` (derived from time).

## Owns
- Tables: `Shop`, `ShopMembership`, `ShopInvite`, `ShopSsoConfig`, `ShopDirectory`, `ShopStatusHistory`.
- Queue: `tenancy-invite-requested`.
- Events: `tenancy.shop_created`, `tenancy.shop_updated`, `tenancy.shop_status_changed`, `tenancy.shop_verification_changed`, `tenancy.shop_plan_changed`, `tenancy.member_added`, `tenancy.member_role_changed`, `tenancy.member_removed`, `tenancy.invite_created`, `tenancy.shop_cell_moved`, `tenancy.shop_offboarding_started`, `tenancy.shop_offboarding_cancelled`, `tenancy.shop_deleted`. State changes and events commit in one transaction; a failed outbox append rolls back the change. [proof: S03 AS-78]
- Consumes: `billing.subscription_plan_changed`, `identity.federated_identity_linked`, `shop.onboarding_submitted`, `shop.verified`, `shop.rejected`, `tenancy.member_removed` (to end open realtime streams).
- Jobs: `tenancy.purge-deleted-shops`, `tenancy.purge-expired-invites`, `tenancy.reseal-sso-secrets`. The former `tenancy.backfill-shops` no longer exists: owning domains backfill their own shop ids through `ShopProvisioningService.ensureShopsForLegacySellers`.
- Rate-limit policies: `tenancy.shop-create.user`, `tenancy.shop-write.shop`, `tenancy.invite.shop`, `tenancy.invite-accept.user`, `tenancy.invite-accept.ip`, `tenancy.sso-lookup.ip`.
- Configuration: `TENANCY_REGIONS`, `TENANCY_CELLS` (JSON cell name to database URL), `TENANCY_CELL_POOL_MAX` (default 5), `TENANCY_CELL_ACQUIRE_TIMEOUT_MS` (default 2000), `TENANCY_CELL_CONNECTION_LIMIT` and `TENANCY_CELL_RESERVED_CONNECTIONS` (defaults 100 and 20); startup fails when the pool arithmetic does not fit the cell.
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
- Seller onboarding (S04) produces `shop.onboarding_submitted` and `shop.verified` on `shops.events` with more fields than tenancy reads; `shop.rejected` is read but not yet produced by anyone. The plan event of billing (S17) is read by contract and not yet produced.
- The pooled database and every cell are checked for `statement_timeout`, but the cell database of the tests shares the server of the test database; a cell on its own server is covered only by configuration validation.
- A suspended shop cannot be closed through the API (the status gate allows only reading and exporting); the machine's `SUSPENDED→DELETING` move is for the platform and has no route.
- AS-27 and AS-83 realtime admission: only the removed-member case has a test (AS-27).
- AS-61 schema rules, AS-74 to AS-77 and AS-79, AS-81 are covered by tests but not summarised as separate rules here.
- Rules R-14 and R-18 are tied to tests only partly: the digest-only storage and the 429 limits come from AS-28 and AS-39 and are not checked separately.