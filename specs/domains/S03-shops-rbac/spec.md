# Feature Specification: S03 — Shops as Tenants: Memberships, Roles and Permissions, Invites, Per-Shop SSO, Cells, Offboarding (domain `tenancy`)

**Feature Branch**: `S03-shops-rbac` (spec directory `specs/domains/S03-shops-rbac`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S03 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-02-multi-tenant-shops.md`, `10-System-Design/04-web-platform-architectures.md` §2, `05-Security/02-authentication-authorization.md` §6–7. Pattern-map rows covered: P0302, P0310, P0315, P0316, P0319, P0513 (shop part), P0515, P0516, P0618.

## Scope

A **shop** is the tenant of the marketplace: a seller organisation with a team, a plan, a verification status, an optional enterprise identity provider and a place in the infrastructure (its cell). This capability decides who may do what inside a shop, and makes sure one shop can never see or disturb another.

In scope:

- Shop creation and profile, plan limits, shop status (`ACTIVE`, `SUSPENDED`, `DELETING`, `DELETED`) and the verification fields that other capabilities feed.
- Tenant resolution once per request, membership checks, the role and permission matrix, record-level rules about who may change whom, the "a shop always keeps an owner" invariant.
- Members, invitations (single-use, signed, delivered by e-mail), per-shop single sign-on and the membership it provisions.
- The tenant directory (`ShopDirectory`): which cell and region a shop lives in, and the connection routing built on it.
- Isolation backstops (row-level security, transaction-scoped tenant context), noisy-neighbour limits, schema and migration discipline for the tenancy tables.
- Offboarding: export, grace period, hard delete of the tenancy data and the event that tells every other domain to delete theirs.
- The exported services and events other domains use instead of reading tenancy tables.

Out of scope (owned elsewhere):

- Accounts, passwords, sessions, platform role changes → **S01**. The OIDC protocol, PKCE, account linking, trust rules → **S02**. Tenancy supplies shop configuration only.
- Onboarding questionnaire, KYC and the verification decision → **S04** (tenancy only records the outcome from its events).
- Plans, prices, subscriptions → **S17**. Seat limits are read from the shop's plan that S17 announces.
- E-mail delivery → **S28**. Rate-limiter engine → **S50**. Scheduler → **S49**. Outbox and consumers → **S53**. Error filter, context, outbound HTTP → **S54**.
- Shop-scoped data of other domains (products, chat, orders, …), their own row-level security, their own shop-id backfill and their own export and purge on `tenancy.shop_deleted`.
- Web screens → **W04** (shop switcher, team, roles matrix) and **W01** (login). Cross-domain journey → **J02**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Open a shop and see only my own (Priority: P1)

A seller creates a shop. They become its owner and nobody else can see it. A member of another shop who guesses its identifier learns nothing, not even that it exists.

**Why this priority**: every other capability scopes its data by the shop this one resolves. A leak here is a leak everywhere.

**Independent Test**: create two shops with two users; each can read its own shop, the other gets "not found" on every shop-scoped route, and no row changed.

**Acceptance Scenarios**:

1. **AS-01** — **Given** a signed-in user with no shop and a free slug, **When** they `POST /shops {name:"Acme", slug:"acme-store"}`, **Then** the response is `201` with a shop whose `plan` is `STARTER`, `status` `ACTIVE`, `verificationStatus` `UNVERIFIED`, `payoutsEnabled` `false`, `region` the platform default, and it has no payment-provider account field; exactly one `Shop` row, one `ShopMembership` `(shop, user, OWNER)` and one `ShopDirectory` row (`cell = pooled`, `version = 1`) exist; the outbox holds `tenancy.shop_created` and `tenancy.member_added` (`source: "owner"`), all committed together; no row of the identity domain's user table was written.
2. **AS-02** — **Given** the create form, **When** `name` is shorter than 2 or longer than 80 characters or not a string; `slug` has uppercase letters, fewer than 3 or more than 40 characters, a leading or trailing hyphen, or non-ASCII characters; the body carries an unknown field (`plan`, `status`, `ownerId`); or `region` is not on the platform's allowed list, **Then** the answer is `400 validation_failed` naming the field (or `422 region_not_allowed` for the region), and nothing is persisted.
3. **AS-03** — **Given** reserved handles (`admin`, `api`, `www`, `shops`, `invites`, `login`, `static`, `support`), the prefix `seller-` and the suffix `-sandbox`, **When** one is submitted as a slug, **Then** `422 slug_reserved`; **Given** a slug in use, **Then** `409 slug_taken`; **Given** two simultaneous creates of one free slug, **Then** exactly one `201` and one `409 slug_taken`, and exactly one shop row exists.
4. **AS-04** — **Given** a user who already owns 10 shops, **When** they create an 11th, **Then** `409 shop_limit_reached` and nothing is persisted; **Given** a user owning 9 shops and two simultaneous creates, **Then** exactly one succeeds and the user owns 10.
5. **AS-05** — **Given** no credentials, **When** any endpoint of this capability (except the public ones named in AS-46 and AS-80) is called, **Then** `401 invalid_token` problem+json and nothing is persisted.
6. **AS-06** — **Given** a member of a shop, **When** they `GET /shops/:shopId`, **Then** `200` with the shop, `myRole` and `myPermissions` (the exact permission list of that role), and the body parses with the contracts schema; **Given** a non-member, **Then** the cross-tenant rules of AS-09 apply.
7. **AS-07** — **Given** a user in three shops, **When** they `GET /shops/mine?limit=2`, **Then** `200 {items, nextCursor}` with their first two memberships ordered by join time then shop ID, each `{id, name, slug, plan, status, role}`, and `nextCursor` is opaque; the next page returns the third item and `nextCursor: null`; shops of other users never appear; `limit` above 100 or a tampered cursor answers `400 validation_failed`.
8. **AS-08** — **Given** a member with `shop.manage`, **When** they `PATCH /shops/:shopId {name}`, **Then** `200` with the new name and `tenancy.shop_updated` in the outbox; **When** the body carries `slug`, `plan` or `status`, **Then** `400 validation_failed` and nothing changes; **When** the caller is a viewer or staff member, **Then** `403 permission_denied`.

---

### User Story 2 — Isolation between shops (Priority: P1)

Every shop-scoped request resolves its shop once, proves membership, and carries the shop through logs, events and database transactions. The database itself refuses cross-shop reads when application code forgets.

**Why this priority**: it is the security property of the whole product (BOLA is OWASP API #1).

**Independent Test**: the BOLA matrix over every route, plus the database-level probe with a role that has no bypass.

**Acceptance Scenarios**:

1. **AS-09** — **Given** a member of shop A, **When** they call any shop-scoped route of this capability for shop B (read shop, list members, list invites, read or write SSO, export, patch, invite, offboard), or for an unknown UUID, or for a malformed identifier, **Then** the answer is `404 shop_not_found` with an identical body for all three cases, no state changes, and the denial counter `reason=not_member` increases.
2. **AS-10** — **Given** a route that resolves the shop from the `X-Shop-Id` header, **When** the header names a shop the caller belongs to, **Then** it works; **When** both the path and the header carry shop IDs and they differ, **Then** `400 shop_mismatch`; **When** the body carries a `shopId`, **Then** `400 validation_failed` (the tenant is never taken from the body).
3. **AS-11** — **Given** one user per role in one shop, **When** each calls every shop-scoped endpoint of this capability, **Then** the outcome equals the permission matrix of FR-020 (`2xx` when allowed, `403 permission_denied` when not), for all four roles and all endpoints.
4. **AS-12** — **Given** a shop in `SUSPENDED`, **When** members call routes needing only `shop.read`, `members.read` or `shop.export`, **Then** `200`; **When** they call any other permission's route they are otherwise allowed, **Then** `403 shop_suspended`; **Given** `DELETING`, **Then** the same read routes plus `shop.delete` (cancel) work and every other route answers `409 shop_offboarding`; **Given** `DELETED`, **Then** every route answers `404 shop_not_found`. A caller lacking the permission gets `403 permission_denied` before any status answer.
5. **AS-13** — **Given** a warmed authorization cache, **When** a member is removed or their role changes, **Then** the very next request on a non-sensitive route reflects it. **Given** a stale "member" entry written into the cache after the removal (the delete-then-repopulate race), **Then** routes needing a sensitive permission (`members.manage`, `sso.manage`, `shop.delete`, `shop.manage`, `shop.export`, `billing.manage`, `payouts.read`, `api-keys.manage`, `webhooks.manage`) still answer `404 shop_not_found`, and non-sensitive routes keep answering from the stale entry for at most 15 s (frozen clock), then `404`. **Given** the cache store is unreachable, **Then** requests are served from the database (never denied, never granted by default) and a fallback counter increases.
6. **AS-14** — **Given** any shop-scoped request, **Then** its log lines and every outbox event it produces carry `shopId` and `requestId`, and no log line contains a token, e-mail address or secret.
7. **AS-15** — **Given** an invite, member or SSO configuration of shop B, **When** the caller (owner of shop A) addresses it through `/shops/A/…` with B's invite ID or member ID, **Then** `404 invite_not_found` or `404 member_not_found` and B's rows are unchanged.

---

### User Story 3 — Roles and permissions that cannot be escalated (Priority: P1)

Roles are per membership: someone can be an owner in one shop and a viewer in another. Endpoints require permissions, not role names. An admin cannot make themselves, or anyone, an owner.

**Why this priority**: broken function-level authorization is how tenants lose control of their own shop.

**Independent Test**: the role × permission table and the actor × target × new-role table, then the escalation attempts over HTTP.

**Acceptance Scenarios**:

1. **AS-16** — **Given** the four roles and the permission list, **When** the matrix is evaluated, **Then** the allowed set per role is exactly the table in FR-020 (table-driven over every role × permission), and an unknown role or permission is denied.
2. **AS-17** — **Given** the matrix, **Then** for every pair of adjacent roles the lower role's permissions are a subset of the higher role's (property over all pairs).
3. **AS-18** — **Given** the record-level rule, **When** `canManage(actor, target, newRole)` is evaluated over all 4 × 4 × 4 combinations, **Then** only an `OWNER` may assign, change or remove `OWNER` or `ADMIN`; an `ADMIN` may manage `STAFF` and `VIEWER` only; `STAFF` and `VIEWER` manage no one; every member may remove themselves (subject to AS-22).
4. **AS-19** — **Given** an `ADMIN`, **When** they promote a `STAFF` to `ADMIN` or `OWNER`, demote or remove an `OWNER` or another `ADMIN`, or invite an `ADMIN`, **Then** `403 insufficient_role`, nothing changes; **When** they promote a `VIEWER` to `STAFF`, **Then** `204`.

---

### User Story 4 — Team membership with a guaranteed owner (Priority: P1)

Owners and admins list the team, change roles and remove people. A shop never ends up without an owner, even when two owners act at the same moment.

**Why this priority**: an ownerless shop cannot be recovered without platform support; the write-skew race is a classic interview case (P0310).

**Independent Test**: two owners demote each other simultaneously; exactly one succeeds.

**Acceptance Scenarios**:

1. **AS-20** — **Given** a shop with members, **When** a member calls `GET /shops/:shopId/members?limit=2`, **Then** `200 {items, nextCursor}` of `{userId, email, role, source, joinedAt}` in join-time order with a unique tiebreaker; e-mail addresses are resolved with one batched call to the identity directory per page (spy shows one call, at most the page size of IDs); a member created through company SSO has `email: null`.
2. **AS-21** — **Given** an owner, **When** they `PATCH /shops/:shopId/members/:userId {role:"STAFF"}`, **Then** `204`, the row changed, `tenancy.member_role_changed {from, to}` is in the outbox and the target's cache entry is gone; **When** the role equals the current one, **Then** `204` with no event; **When** the user is not a member, **Then** `404 member_not_found`; **When** `role` is not one of the four, **Then** `400 validation_failed`.
3. **AS-22** — **Given** a shop with exactly one owner, **When** that owner demotes themselves or removes themselves (or is removed by anyone), **Then** `409 last_owner` and nothing changes; **Given** two owners, **Then** one may step down.
4. **AS-23** — **Given** two owners A and B, **When** A demotes B and B demotes A at the same moment (`Promise.all`), **Then** exactly one `204` and one `409 last_owner`, and exactly one owner remains; the same holds when A removes B while B demotes A.
5. **AS-24** — **Given** the store reports serialization conflicts three times in a row for one change, **When** the request retries (exponential back-off with full jitter, 3 attempts), **Then** the answer is `503 serialization_failure` with `Retry-After: 1`, nothing changed, and the retry counter shows 2 retries; a conflict that clears on the second attempt returns the normal result.
6. **AS-25** — **Given** any member, **When** they `DELETE /shops/:shopId/members/:ownUserId`, **Then** `204` and `tenancy.member_removed {reason:"left"}` — even for a viewer without `members.manage`; **When** a viewer removes someone else, **Then** `403 permission_denied`.
7. **AS-26** — **Given** a removed member whose membership came from company SSO (`source: "sso"`), **Then** after commit all their sessions are revoked through the identity directory service with reason `shop_membership_removed` (their sessions fail refresh with `401`); **Given** a member of any other source, **Then** their sessions are untouched and only shop access ends.
8. **AS-27** — **Given** a member removed from a shop, **When** they subscribe to the realtime topic `shop:<shopId>:live`, **Then** the subscription is refused; while a still-valid member's is accepted; a deleted shop refuses everyone.

---

### User Story 5 — Invite teammates safely (Priority: P1)

An owner or admin invites a colleague by e-mail with a role. The invitee receives a single-use link, signs in with the invited address and joins. The inviter never sees the link.

**Why this priority**: accounts are created without proving e-mail ownership (S01), so a link visible to the inviter would let the inviter join as anyone.

**Independent Test**: invite, read the delivered message, accept as the right user, replay, and try as the wrong user.

**Acceptance Scenarios**:

1. **AS-28** — **Given** a member with `members.manage`, **When** they `POST /shops/:shopId/invites {email:" New@Mail.com ", role:"VIEWER"}`, **Then** `201 {id, email:"new@mail.com", role, status:"pending", expiresAt (+7 days), invitedBy, createdAt}` with no token and no link; the stored row holds only a digest of the token; the outbox holds one single-consumer message `tenancy.invite_requested` carrying the token; `tenancy.invite_created` (identifiers only) is published; no log line contains the token.
2. **AS-29** — **Given** the invite form, **When** the e-mail is malformed or longer than 254 characters, `role` is `OWNER` or unknown, or an unknown field is present, **Then** `400 validation_failed` and nothing is persisted.
3. **AS-30** — **Given** an address that already belongs to a member, **Then** `409 already_member`; **Given** a pending (unexpired) invite for that address in that shop, **Then** `409 invite_pending`; **Given** an expired pending invite, **Then** a new invite is created and the expired one is marked revoked, both in one transaction.
4. **AS-31** — **Given** a `STARTER` shop (5 seats) with an owner, three members and one pending invite (seats = members + unexpired pending invites), **When** another invite is created, **Then** `409 seat_limit_reached`; **Given** one free seat and two simultaneous invites, **Then** exactly one `201` and one `409`; **Given** the plan was raised to `PRO` (25 seats) by AS-73, **Then** the invite succeeds; **Given** a plan lowered below current usage, **Then** nobody is removed and new invites answer `409`.
5. **AS-32** — **Given** a valid link token and the invited person signed in, **When** they `POST /shop-invites/accept {token}`, **Then** `201 {shopId, role}`, a membership `(shop, user, role, source:"invite")` exists, the invite is marked accepted by that user, `tenancy.member_added` is in the outbox and the user's cache entry is gone; the invited address is compared with the account's address obtained from the identity directory (access tokens carry no address).
6. **AS-33** — **Given** an unknown token, an expired one (frozen clock +7 days +1 s), a revoked invite, an already used one, a token invited for another address, a signed-in account without an address, or an invite of a shop that is `SUSPENDED`, `DELETING` or `DELETED`, **When** accepted, **Then** every case answers the same `404 invite_not_found` body and nothing changes; a token longer than 128 characters answers `400 validation_failed`.
7. **AS-34** — **Given** one valid token, **When** two accept requests arrive at once (`Promise.all`), **Then** exactly one `201` and one `404 invite_not_found`, and exactly one membership exists.
8. **AS-35** — **Given** the invitee is already a member (for example an `OWNER`), **When** they accept an invite, **Then** `200 {shopId, role: <existing role>, alreadyMember:true}`, the existing role is unchanged and the invite is consumed.
9. **AS-36** — **Given** a pending invite, **When** a member with `members.manage` calls `DELETE /shops/:shopId/invites/:inviteId`, **Then** `204` and its token no longer works (AS-33); a repeat answers `204`; revoking an accepted invite answers `409 invalid_transition`; an invite of another shop answers `404 invite_not_found`.
10. **AS-37** — **Given** a pending or expired invite, **When** `POST /shops/:shopId/invites/:inviteId/resend`, **Then** `200` with a fresh expiry, the old token dead, a new `tenancy.invite_requested` message; an accepted or revoked invite answers `409 invalid_transition`.
11. **AS-38** — **Given** invites in each state, **When** `GET /shops/:shopId/invites?status=pending|expired|accepted|revoked&limit=…`, **Then** the derived status matches the frozen clock, pages are cursor-based, and the body never contains a token or digest; a viewer gets `403 permission_denied`.
12. **AS-39** — **Given** a shop that created 20 invites within one hour, **When** it creates a 21st, **Then** `429 rate_limited` with `Retry-After` and no invite is created, while another shop's invite in the same hour succeeds; **Given** a user with 10 failed accepts in 15 minutes, **Then** the 11th answers `429` before the token is looked up.

---

### User Story 6 — Company sign-in per shop (Priority: P2)

A shop owner connects the company's identity provider. Staff then sign in through it and land in the shop with a default role, without invitations.

**Why this priority**: enterprise shops require it, but it builds on stories 1–5.

**Independent Test**: configure against the fake provider, run a login through S02's engine, observe the membership.

**Acceptance Scenarios**:

1. **AS-40** — **Given** an owner and a reachable provider, **When** they `PUT /shops/:shopId/sso {issuer, clientId, clientSecret, defaultRole:"VIEWER"}`, **Then** `200 {providerId:"shop:<shopId>", issuer, clientId, defaultRole, enabled:true, secretSet:true, updatedAt}`; the secret is stored sealed with a context bound to the shop (opening it with another shop's context fails); the provider registry's cached settings for that provider are invalidated; an audit line is written; an `ADMIN` gets `403 permission_denied`.
2. **AS-41** — **Given** the SSO form, **When** the issuer is not `https`, points to a loopback, private, link-local or metadata address (SSRF guard), has a discovery document whose `issuer` differs, is unreachable, or does not answer within 3 s, or `defaultRole` is `OWNER` or `ADMIN`, or `clientSecret` exceeds 512 characters, **Then** the answer is `400 validation_failed`, `422 sso_issuer_invalid`, `422 sso_issuer_mismatch` or `422 sso_issuer_unreachable` (the timeout case within 3.5 s) and nothing is persisted or invalidated.
3. **AS-42** — **Given** an existing configuration, **When** `PUT` omits `clientSecret`, **Then** the stored secret is kept; **When** it carries a new one, **Then** it is replaced; **When** the identical request is replayed, **Then** `200` with the same body and the same effective state.
4. **AS-43** — **Given** a configuration, **When** `GET /shops/:shopId/sso`, **Then** `200` without any secret material (`secretSet:true` only); a viewer or staff member gets `403 permission_denied`; a non-member gets `404 shop_not_found`; an unconfigured shop answers `404 sso_not_configured`.
5. **AS-44** — **Given** an enabled configuration, **When** `DELETE /shops/:shopId/sso`, **Then** `204`, the row including its sealed secret is gone, the registry cache is invalidated, the provider resolves to "unknown" and `GET /shops/by-slug/:slug/sso` answers `404`; a repeat answers `204`.
6. **AS-45** — **Given** the resolver registered for the `shop:` prefix, **When** it is asked for `shop:<uuid>` of an enabled configuration on an `ACTIVE` shop, **Then** it returns `{issuer, clientId, clientSecret (opened, plain), scope?}`; for a malformed ID, another prefix, a disabled or missing configuration, or a shop that is `SUSPENDED`, `DELETING` or `DELETED`, it returns "unknown"; it runs inside the shop's own database context.
7. **AS-46** — **Given** anonymous visitors, **When** they `GET /shops/by-slug/:slug/sso`, **Then** `200 {providerId, displayName}` for a shop with SSO enabled and an identical `404` for an unknown slug, a disabled configuration and a suspended shop; the 31st call in a minute from one IP answers `429`.
8. **AS-47** — **Given** `identity.federated_identity_linked {provider:"shop:<id>", userId}` for a shop with SSO enabled and a free seat, **When** the event is processed, **Then** a membership with the configured `defaultRole` and `source:"sso"` exists and `tenancy.member_added` is published; **When** the same event is delivered again, **Then** no second membership or event; **When** another event for the same user and shop arrives, **Then** nothing changes (the existing membership wins).
9. **AS-48** — **Given** the same event, **When** the shop does not exist, SSO is disabled, the shop is not `ACTIVE`, or the provider is `google`, **Then** it is acknowledged and ignored with an `ignored` counter and no row; **When** no seat is free, **Then** no membership, a `denied` counter and an audit line; **When** the payload is invalid, **Then** it is dead-lettered with no side effect.
10. **AS-49** — **Given** a member removed after SSO provisioning, **When** the original event is redelivered (same `eventId`), **Then** the member is not re-added.
11. **AS-50** — **Given** an owner who configured SSO against the fake provider, **When** a staff member runs the login through S02's start and callback for `shop:<id>`, **Then** a new account is created (S02 trust rules), the membership appears with the default role and `GET /shops/:shopId` answers `200` for that account with that role.

---

### User Story 7 — Cells: a big shop moves without code changes (Priority: P2)

Most shops share the pooled database. A shop that outgrows it, or buys dedicated infrastructure, is moved to its own cell by changing its directory entry; no domain changes.

**Why this priority**: it is the scale story of SD-02; the first bottleneck is one huge shop dominating the pooled database (P0319).

**Independent Test**: move a shop between cells and watch its connection change, then exhaust the dedicated pool and watch the pooled shops stay unaffected.

**Acceptance Scenarios**:

1. **AS-51** — **Given** a new shop, **Then** its directory row is `cell: pooled`, the platform default `region` or the requested allowed one, `version: 1`; `cellOf(shopId)` returns `{cell, region}`.
2. **AS-52** — **Given** a platform administrator, **When** `PUT /admin/shops/:shopId/directory {cell:"dedicated-1", region, expectedVersion:1, reason}`, **Then** `200 {shopId, cell, region, version:2}`, `tenancy.shop_cell_moved {fromCell, toCell, region, version}` is published, the cached cell is dropped and an audit line records the actor and reason; a non-admin gets `403`; a cell not in the configured set answers `422 unknown_cell`; a stale `expectedVersion` answers `409 stale_version`; two simultaneous moves with the same `expectedVersion` yield exactly one `200` and one `409`.
3. **AS-53** — **Given** a shop in `dedicated-1`, **When** its connection is resolved, **Then** it is that cell's pool; a pooled shop gets the pooled connection; **Given** a directory row naming a cell the process has no connection for, **Then** resolution fails with `503 cell_unavailable` and never falls back to the pooled database.
4. **AS-54** — **Given** the dedicated pool fully held (size 1) and a request for a shop in that cell, **When** it waits more than 2 s for a connection, **Then** `503 cell_unavailable` with `Retry-After`; at the same time requests for pooled shops all answer `200` within the normal latency budget (bulkhead).
5. **AS-55** — **Given** a resolved cell, **When** it is resolved again, **Then** no database query runs; after a move it is re-read; if an invalidation is lost, staleness is bounded by the 5-minute entry lifetime.
6. **AS-56** — **Given** a shop's region, **Then** it appears in the shop body and changes only through AS-52.

---

### User Story 8 — Isolation backstop and schema discipline (Priority: P1)

Even if code forgets a filter, the database returns nothing for the wrong tenant. The tenant context lives and dies with the transaction, so a shared connection pool cannot leak it. Migrations keep running code working.

**Why this priority**: it is the second layer of P0516 and the pooling pitfall of P0316.

**Independent Test**: probe the tables as a role without bypass rights, run alternating transactions on a pool of one connection, apply the migrations twice.

**Acceptance Scenarios**:

1. **AS-57** — **Given** a role without superuser or bypass rights, **When** it reads `ShopInvite`, `ShopSsoConfig` or `ShopMembership` with no tenant set, **Then** 0 rows; **When** the context is shop A, **Then** only A's rows (membership rows are also visible to the user they belong to); **When** a transaction scoped to A inserts a row for B, **Then** the database rejects it.
2. **AS-58** — **Given** a pool with one connection, **When** a transaction runs in shop A's context, commits (or rolls back) and the next transaction on the same connection runs in shop B's context and a third with no context, **Then** B sees only B's rows and the third sees none, and the tenant setting is empty after each transaction.
3. **AS-59** — **Given** the audited bypass, **When** it is used with a reason from the allowlist (`invite.accept`, `sso.provision`, `shop.purge`, `legacy.provision`, `membership.mine`), **Then** a counter by reason increases and the reason is logged; **When** any other reason is passed, **Then** the call throws before any query; the bypass setting is gone after the transaction.
4. **AS-60** — **Given** production mode and a database role with superuser or bypass rights, **When** the application starts, **Then** it fails with a message naming the role attribute; in test mode it logs a warning.
5. **AS-61** — **Given** the migrated schema, **Then**: every tenancy table keeps its indexes leading with the shop identifier (`ShopMembership(shopId,userId)` primary key, `(userId, createdAt)`, `ShopInvite(shopId, createdAt DESC)`); at most one pending invite per `(shop, lower(email))`; no tenancy table has a foreign key to another owner's table; the migrations run up, down and up again without error and set a lock timeout; none renames or drops a column that running code reads.
6. **AS-62** — **Given** legacy sellers, **When** `ensureShopsForLegacySellers([u1,u2,u1])` runs, **Then** each distinct seller has exactly one shop (slug `seller-<id>`), one `OWNER` membership and one directory row and the map `{u1,u2}` is returned; a second call returns the same shop IDs and creates no row or event; two concurrent calls converge on one shop per seller; a batch above 200 IDs is refused with a validation error; a failure on the third seller rolls the whole batch back and a retry converges.
7. **AS-63** — **Given** a live shop, **When** `ensureSandboxShop(liveShopId)` is called twice or concurrently, **Then** exactly one sandbox shop exists (slug `<slug>-sandbox`, `isSandbox: true`, `sandboxOf` the live ID, no members); an unknown live shop answers not-found; a sandbox of a sandbox is refused; sandbox shops never appear in `mine`, the public batch read or the SSO lookup.

---

### User Story 9 — Offboarding and shop lifecycle (Priority: P2)

An owner can export the shop's data and close the shop. After a grace period the tenancy data is hard-deleted and every other domain is told to delete theirs. The platform can suspend a shop.

**Why this priority**: GDPR and the exit story of 10/04 §2; also the only legal way to remove a tenant.

**Independent Test**: start offboarding, cancel, start again, advance the clock past the grace period, run the purge, observe the tombstone.

**Acceptance Scenarios**:

1. **AS-64** — **Given** the status machine, **When** every (status, transition) pair is evaluated (`ACTIVE→SUSPENDED`, `SUSPENDED→ACTIVE`, `ACTIVE→DELETING`, `SUSPENDED→DELETING`, `DELETING→ACTIVE`, `DELETING→DELETED`), **Then** only those succeed and each other pair is `invalid_transition` (table-driven, ending in an exhaustive check).
2. **AS-65** — **Given** a platform administrator with a sensitive session, **When** `POST /admin/shops/:shopId/suspend {reason}`, **Then** `200`, status `SUSPENDED`, `tenancy.shop_status_changed` published, the provider cache for the shop invalidated; suspending a suspended shop, reinstating an active one, or reinstating a `DELETING` shop answers `409 invalid_transition`; a missing reason answers `400`; a non-admin answers `403`; a suspend and an offboarding start racing on an `ACTIVE` shop yield exactly one winner and a consistent final status.
3. **AS-66** — **Given** an owner, **When** `POST /shops/:shopId/offboarding {confirmSlug:"<slug>"}`, **Then** `200 {status:"DELETING", purgeAt: now + 30 days}` and `tenancy.shop_offboarding_started {purgeAt}` is published; a wrong confirmation answers `422 confirmation_mismatch`; an `ADMIN` answers `403`; a repeat while `DELETING` answers `200` with the same `purgeAt` and no second event.
4. **AS-67** — **Given** a `DELETING` shop, **When** an owner calls `DELETE /shops/:shopId/offboarding`, **Then** `200`, status `ACTIVE`, `tenancy.shop_offboarding_cancelled` published; on an `ACTIVE` shop it answers `409 invalid_transition`; on a purged shop `404`.
5. **AS-68** — **Given** an owner, **When** `GET /shops/:shopId/export`, **Then** `200` with `Cache-Control: no-store` and `{generatedAt, shop, members:[{userId,email,role,source,joinedAt}], invites:[{id,email,role,status,createdAt}], sso:{issuer,clientId,defaultRole,enabled}|null}` and no secret or digest; it works in `SUSPENDED` and `DELETING`; an `ADMIN` answers `403`.
6. **AS-69** — **Given** a `DELETING` shop and a frozen clock before `purgeAt`, **When** the purge job runs, **Then** nothing changes; **Given** the clock after `purgeAt`, **Then** the shop's memberships, invites, SSO configuration and directory row are deleted, the shop row becomes a tombstone (`status DELETED`, name `[deleted]`, slug `deleted-<id>`, no personal data), `tenancy.shop_deleted` is published, the sessions of former `source:"sso"` members are revoked, the old slug can be registered again, and the former owner gets `404` everywhere; a second run adds no event; two concurrent runs purge once; a failure on one shop does not stop the others (each shop in its own transaction).
8. **AS-70** — **Given** a `DELETING` or `SUSPENDED` shop, **Then** no new invite can be created, accepted or resent and no SSO provisioning happens (AS-12, AS-33, AS-48).
9. **AS-71** — **Given** the verification state machine, **When** every (status, event) pair is evaluated, **Then** `UNVERIFIED→PENDING` on submission, `PENDING→VERIFIED` and `PENDING→REJECTED` on a decision, `REJECTED→PENDING` on resubmission, `VERIFIED` ignores every later event, and `payoutsEnabled` is true only when `VERIFIED` (table-driven).
10. **AS-72** — **Given** `shop.onboarding_submitted {shopId}` and `shop.verified {shopId}` (and `shop.rejected` when S04 emits it), **When** they are processed, **Then** the verification fields follow AS-71 and `tenancy.shop_verification_changed` is published; the same `eventId` twice produces one change and one event; `verified` arriving before `submitted` leaves the shop `VERIFIED` after the late `submitted`; an unknown or `DELETED` shop is ignored with a counter; an invalid payload is dead-lettered without effect.
11. **AS-73** — **Given** `billing.subscription_plan_changed {shopId, plan, version}`, **When** it is processed, **Then** the plan changes and `tenancy.shop_plan_changed` is published; an older `version` than the stored one is ignored; a duplicate changes nothing; an invalid plan is dead-lettered.

---

### User Story 10 — Other domains use tenancy through exported services and events (Priority: P1)

Other domains stop reading shop and membership tables. They ask exported services and listen to events.

**Why this priority**: it pays debt D-7 and D-12 for tenancy's tables (constitution IX).

**Independent Test**: the static ownership check shows zero findings for tenancy tables, and each exported service passes its contract tests.

**Acceptance Scenarios**:

1. **AS-74** — **Given** `ShopAccessService.assertMember(shopId, userId, permission)`, **When** called for a member with the permission, **Then** it returns `{role}`; for a non-member, unknown shop or `DELETED` shop it throws not-found (`404 shop_not_found` when it reaches the HTTP layer); for a missing permission it throws forbidden; the status rules of AS-12 and the strong read for sensitive permissions apply.
2. **AS-75** — **Given** `ShopQueryService.getShopsByIds(ids)`, **When** called with up to 500 IDs, **Then** it returns a map of `ShopSummaryDto` (no payment-provider account), unknown IDs are absent, duplicates collapse, suspended and tombstoned shops are included with their status, and exactly one query is issued; 501 IDs is refused.
3. **AS-76** — **Given** `MembershipQueryService.getMembersByShopIds(shopIds, roles?)`, **When** called with up to 500 IDs, **Then** one query returns `Map<ShopId, {userId, role}[]>`, optionally filtered by role, in deterministic order.
4. **AS-77** — **Given** the strict static checks, **Then** no domain other than tenancy reads, joins, associates, injects or imports `Shop`, `ShopMembership`, `ShopInvite`, `ShopDirectory` or `ShopSsoConfig`; tenancy touches no table it does not own (no join on users, no write to users); the barrel exports no model; the only cross-owner write is the outbox append.
5. **AS-78** — **Given** each mutation of this capability, **When** its outbox append is forced to fail, **Then** the mutation is rolled back (no partial state); **When** an operation is rejected, **Then** no event is emitted; **Then** every event carries `eventId`, `type`, `version`, `occurredAt`, `aggregateId = shopId`, `shopVersion` where stated, and identifiers only (the invite token message is the one exception).
6. **AS-79** — **Given** every error of this capability, **Then** it is problem+json with the stable code of FR-100 and `requestId`; a forced database failure answers a generic `500` with no SQL or stack; every success body parses with its contracts schema.
7. **AS-80** — **Given** `GET /batch/shops?ids=a,b,c` (the endpoint the BFF composes, R2), **When** called anonymously, **Then** `200` an array in request order of `{id, name, slug}` or `null`; sandbox, `SUSPENDED`, `DELETING` and `DELETED` shops are `null`; more than 100 IDs or a malformed ID answers `400 validation_failed`; the response has `Cache-Control: public, max-age=30`.
8. **AS-81** — **Given** the observability rules, **When** invites, role changes, SSO changes, status changes, cell moves and offboarding steps happen, **Then** each writes an audit line with `actorId`, `shopId`, `action`, `requestId` and no e-mail, token or secret; counters exist for denials by reason, bypass by reason, invite outcomes, serialization retries, provisioning outcomes; no metric label is a shop or user identifier.
9. **AS-82** — **Given** `GET /shop-roles`, **When** an authenticated user calls it, **Then** `200 {roles:{OWNER:[…],ADMIN:[…],STAFF:[…],VIEWER:[…]}, permissions:[…]}` equal to FR-020 and parsing with its contracts schema; without credentials `401`.
10. **AS-83** — **Given** the realtime policy for `shop:<id>:live`, **Then** members of an `ACTIVE` or `SUSPENDED` shop are admitted and everyone else (non-member, removed member, `DELETED` shop) is refused.

### Edge Cases

- An invite for an address that later registers: the link works for the account whose address equals the invited address; an account with another address, or none, cannot use it (AS-33).
- Two owners act at the same instant on each other (AS-23); a serialization failure persists (AS-24).
- Provisioning events replayed after removal (AS-49), arriving out of order or twice (AS-47, AS-72, AS-73).
- The cache disagrees with the database (AS-13); the cache store is down (AS-13).
- A shop is suspended or closing while invites, SSO logins or provisioning are in flight (AS-12, AS-33, AS-48, AS-70).
- A plan is lowered below current usage (AS-31).
- A directory row names a cell this process cannot reach (AS-53); the dedicated pool is saturated (AS-54).
- Deleted shop's slug and invites: purge frees the slug and removes the addresses (AS-69).

## Requirements *(mandatory)*

### Functional Requirements

**Shops and plan**

- **FR-001**: Creating a shop MUST atomically create the shop, an `OWNER` membership for the creator, a pooled directory entry and the events of AS-01; it MUST NOT write any other domain's data (AS-01).
- **FR-002**: Input is validated strictly: unknown fields, names 2–80 characters, slugs 3–40 characters of `[a-z0-9-]` not starting or ending with a hyphen, regions from the allowed list; reserved handles, the prefix `seller-` and the suffix `-sandbox` are refused; slugs are unique and immutable (AS-02, AS-03, AS-08).
- **FR-003**: A user MAY own at most 10 shops; the limit is enforced under concurrency by the store (AS-04).
- **FR-004**: Shop bodies are explicit DTOs: id, slug, name, plan, status, verification status, payouts flag, region, creation time, and for a member `myRole` and `myPermissions`; no payment-provider account or internal field (AS-01, AS-06).
- **FR-005**: Lists (`mine`, members, invites) use cursor pagination with an opaque cursor, a deterministic order ending in a unique tiebreaker, default 50 and maximum 100 (AS-07, AS-20, AS-38).
- **FR-006**: Plans carry seat limits: `STARTER` 5, `PRO` 25, `ENTERPRISE` 250. Seats used = members + unexpired pending invites. Creating an invite or provisioning a member is refused at the limit; the check and the insert are serialised per shop by the store; lowering a plan removes nobody (AS-31, AS-73).
- **FR-007**: Shop status follows the machine of AS-64 with conditional updates that assert one affected row; every transition appends a history record and an event in the same transaction; illegal transitions answer `409 invalid_transition` (AS-64, AS-65).
- **FR-008**: Verification status and the payouts flag change only by the events of AS-72 and the machine of AS-71; `VERIFIED` is final; processing is idempotent and order-tolerant.

**Tenant resolution and permissions**

- **FR-010**: The shop is resolved once per request from the path or the `X-Shop-Id` header, never from the body; a disagreement answers `400 shop_mismatch` (AS-10).
- **FR-011**: A caller who is not a member, an unknown shop, a malformed identifier and a deleted shop are indistinguishable: `404 shop_not_found`. Every lookup of a shop-owned record puts the shop and the principal in the predicate; loading by identifier and checking afterwards is forbidden (AS-09, AS-15).
- **FR-012**: The order of answers is: `401`, then `404`, then `403 permission_denied`, then the status gate of FR-013 (AS-12).
- **FR-013**: Status gate: `SUSPENDED` allows `shop.read`, `members.read`, `shop.export` and refuses the rest with `403 shop_suspended`; `DELETING` allows those and `shop.delete` and refuses the rest with `409 shop_offboarding`; `DELETED` is `404` (AS-12).
- **FR-014**: After resolution the shop and role are in the request context and flow into logs, events and database transactions (AS-14).
- **FR-015**: Authorization lookups use a cache that is never the source of truth: shared store only (no per-process layer), entries live at most 15 s (negative 10 s), writers delete the entry after commit, and permissions marked sensitive always read the database. Cache failure falls back to the database (AS-13).

**Roles**

- **FR-020**: The permission matrix is exactly:

  | Permission | OWNER | ADMIN | STAFF | VIEWER |
  |---|---|---|---|---|
  | `shop.read`, `members.read`, `products.read`, `orders.read` | ✔ | ✔ | ✔ | ✔ |
  | `products.write`, `orders.manage` | ✔ | ✔ | ✔ | — |
  | `shop.manage`, `members.manage`, `payouts.read`, `api-keys.manage`, `webhooks.manage`, `integrations.manage` | ✔ | ✔ | — | — |
  | `shop.delete`, `shop.export`, `billing.manage`, `sso.manage` | ✔ | — | — | — |

  Unknown roles and permissions are denied (AS-16, AS-17, AS-82).
- **FR-021**: Record-level rule (`canManage`): only an `OWNER` may assign, change or remove `OWNER` or `ADMIN`; an `ADMIN` manages `STAFF` and `VIEWER`; every member may remove themselves. Violations answer `403 insufficient_role` (AS-18, AS-19, AS-25).
- **FR-022**: A shop MUST always keep at least one `OWNER`. The invariant is enforced by the store under serializable isolation with bounded retry on serialization failure (3 attempts, exponential back-off with full jitter); exhaustion answers `503 serialization_failure` with `Retry-After`; violations answer `409 last_owner` (AS-22, AS-23, AS-24) (P0310).
- **FR-023**: Membership changes publish `tenancy.member_added`, `tenancy.member_role_changed`, `tenancy.member_removed` and invalidate the cache after commit; removing a member whose source is `sso` revokes their sessions through the identity directory services (AS-21, AS-26).

**Invitations**

- **FR-030**: Invite tokens are random with at least 192 bits, stored only as a digest, valid 7 days, single-use, and never returned by the API or logged; the only channel is the single-consumer message to the notification capability (AS-28).
- **FR-031**: Invite states are `pending`, `accepted`, `revoked`, `expired` (derived from time); acceptance, revocation and resend are conditional state changes with one winner; a second accept never creates a second membership (AS-34, AS-36, AS-37).
- **FR-032**: Acceptance requires the invited address to equal the signed-in account's address (from the identity directory, case-insensitive); every failure is the same `404 invite_not_found` (AS-32, AS-33).
- **FR-033**: Acceptance never changes the role of an existing member (AS-35). Duplicate and pending invites are refused as in AS-30; seats as in FR-006.
- **FR-034**: Invites cannot grant `OWNER`; ownership moves by promoting an existing member (FR-021) (AS-29).
- **FR-035**: Invite creation is limited to 20 per shop per hour and failed acceptances to 10 per user per 15 minutes, with `429` and `Retry-After`; limits are per shop or user so one shop never consumes another's allowance (AS-39) (P0618).

**Per-shop SSO**

- **FR-040**: Only an `OWNER` configures SSO. The issuer must be `https`, pass the SSRF guard, answer discovery within 3 s and name itself identically; the client secret is sealed with a shop-bound context, never returned and removed when SSO is disabled (AS-40–AS-44).
- **FR-041**: Tenancy registers a resolver for the `shop:` prefix with the provider registry of S02 and invalidates the registry after every configuration, status or deletion change; the resolver answers only for enabled configurations on `ACTIVE` shops (AS-45).
- **FR-042**: A first login through a shop provider provisions a membership with the configured `defaultRole` (`STAFF` or `VIEWER`, never `ADMIN` or `OWNER`) and source `sso`, through the event `identity.federated_identity_linked`; processing is idempotent by `eventId` and by membership uniqueness, validates its payload and dead-letters poison (AS-47–AS-49).
- **FR-043**: The public lookup by slug reveals only `{providerId, displayName}` and is identical for every non-SSO case (AS-46).

**Cells and isolation**

- **FR-050**: `ShopDirectory` maps each shop to `{cell, region, version}`; changes are conditional on `version`, require a platform administrator with a sensitive session and a reason, publish `tenancy.shop_cell_moved` and are audited (AS-51, AS-52).
- **FR-051**: Connection routing is fail-closed: an unknown or unreachable cell is `503 cell_unavailable`, never the pooled database; each cell has its own bounded pool with a 2 s acquire timeout, so a saturated cell affects only its shops (AS-53, AS-54).
- **FR-052**: Cell lookups are cache-aside with a 5-minute lifetime, dropped on write (AS-55).
- **FR-053**: Every shop-private tenancy table enforces row-level security with the tenant set per transaction (never per session); the application role has no superuser or bypass right and startup verifies it; the cross-tenant bypass accepts only allowlisted reasons and is counted and logged (AS-57–AS-60) (P0516, P0316).
- **FR-054**: Tenancy tables carry no foreign key to another owner's table; indexes lead with the shop identifier; uniqueness is per tenant; migrations are expand/contract with a lock timeout and are reversible (AS-61) (P0302, P0315).
- **FR-055**: Legacy and sandbox shops are provisioned only through the exported idempotent services of AS-62 and AS-63; owning domains run their own batched shop-id backfills with them (P0315).

**Offboarding**

- **FR-060**: Only an `OWNER` starts or cancels offboarding, with the slug as confirmation; the grace period is 30 days; start and cancel are idempotent in effect (AS-66, AS-67).
- **FR-061**: Export contains only data tenancy owns, no secrets, and is `no-store` (AS-68).
- **FR-062**: A scheduled, single-run, idempotent job purges due shops, one transaction per shop; it keeps a tombstone without personal data, frees the slug and publishes `tenancy.shop_deleted` (AS-69).

**Boundaries, events, observability, errors**

- **FR-070**: Exported services (R1): `ShopAccessService`, `ShopQueryService`, `MembershipQueryService`, `ShopProvisioningService`, `ShopCellService`; all return DTOs, never models, and batch methods are used (AS-62, AS-63, AS-74–AS-76).
- **FR-071**: Tenancy reads user data only through the identity directory (R1) and writes no other domain's tables; its only cross-owner write is the outbox append (AS-77).
- **FR-072**: State changes and their events commit in one transaction; rejected operations emit nothing; consumers validate payloads and are idempotent (AS-78).
- **FR-080**: No network call happens inside an open transaction: SSO discovery runs before it; session revocation and cache invalidation after commit.
- **FR-081**: Security-relevant actions are audited without secrets; metrics carry no tenant labels (AS-81).
- **FR-090**: Rate-limit policies are declared as listed under Cross-capability contracts.
- **FR-100**: Errors are problem+json with stable codes: `validation_failed` 400, `shop_mismatch` 400, `invalid_token` 401, `permission_denied` 403, `insufficient_role` 403, `shop_suspended` 403, `shop_not_found` 404, `member_not_found` 404, `invite_not_found` 404, `sso_not_configured` 404, `slug_taken` 409, `shop_limit_reached` 409, `seat_limit_reached` 409, `already_member` 409, `invite_pending` 409, `last_owner` 409, `invalid_transition` 409, `shop_offboarding` 409, `stale_version` 409, `slug_reserved` 422, `region_not_allowed` 422, `unknown_cell` 422, `confirmation_mismatch` 422, `sso_issuer_invalid` 422, `sso_issuer_mismatch` 422, `sso_issuer_unreachable` 422, `rate_limited` 429, `serialization_failure` 503, `cell_unavailable` 503; any 5xx is generic (AS-79).

### Key Entities

- **Shop**: `{id, slug, name, plan, planVersion, status, purgeAt?, verificationStatus, payoutsEnabled, region, sandboxOf?, shopVersion, createdAt, updatedAt}`; slug unique; tombstoned on purge.
- **Membership**: `{shopId, userId, role, source: owner|invite|sso|provisioned, createdAt}`; one per `(shop, user)`; per membership role.
- **Invite**: `{id, shopId, email, role, tokenDigest, invitedBy, expiresAt, acceptedAt?, acceptedBy?, revokedAt?, createdAt}`; at most one pending per `(shop, address)`.
- **SSO configuration** (one per shop): `{shopId, issuer, clientId, sealed secret, defaultRole, enabled, updatedAt}`.
- **Directory entry** (one per shop): `{shopId, cell, region, version, updatedAt}`.
- **Status history**: `{shopId, from, to, actor, reason, at}`.
- **Permission matrix**: static table of FR-020.

### Consistency model (P0610)

Strong: slug uniqueness, shop count per user, seat limit, the "at least one owner" invariant, single-use of invites, status and directory transitions, membership uniqueness, sensitive-permission checks. Bounded-stale: non-sensitive authorization cache (≤ 15 s, only in the delete-then-repopulate race; normally 0), cell lookups (≤ 5 min if an invalidation is lost), access tokens (platform role changes follow S01: ≤ 300 s). Eventual: events to other domains (outbox), verification and plan updates from other domains, SSO provisioning, platform role promotion after shop creation.

## Cross-capability contracts

Earlier specs searched (`grep` over `specs/domains`, `specs/web`, `specs/journeys` for `S03` and `tenancy`): S01 and S02 name this capability; `specs/web` and `specs/journeys` do not exist yet. Every contract they require from S03 is honoured: S01 (consumer of `UserDirectoryService`, `SessionRevocationService`, `SecretBox`; offboarding revocation) and S02 (`OidcProviderRegistry.registerResolver('shop:', …)`, `invalidate`, plain secret, membership provisioning from `identity.federated_identity_linked`, tenancy stops using `OidcService`). Where S03 needs an addition, it is a `[CONTRACT]` line in `questions.md`.

**Provides** (exact names; exported from `@app/domains/tenancy` unless it is an HTTP endpoint):

- HTTP under `/api`, problem+json errors, schemas in `packages/contracts` (`shopSchema`, `shopListItemSchema`, `shopMemberSchema`, `shopInviteSchema`, `shopSsoConfigSchema`, `shopSsoLookupSchema`, `shopExportSchema`, `shopRolesSchema`, `shopDirectorySchema`, `pageSchema(…)` = `{items, nextCursor}`):
  - `POST /shops {name, slug, region?}` → `201 shopSchema`; `GET /shops/mine?limit&cursor` → page of `{id,name,slug,plan,status,role}`; `GET /shops/:shopId` → `shopSchema` + `myRole` + `myPermissions`; `PATCH /shops/:shopId {name}`.
  - `GET /shops/:shopId/members?limit&cursor` → page of `{userId, email|null, role, source, joinedAt}`; `PATCH /shops/:shopId/members/:userId {role}` → `204`; `DELETE /shops/:shopId/members/:userId` → `204` (also self-leave).
  - `POST /shops/:shopId/invites {email, role}` → `201 {id,email,role,status,expiresAt,invitedBy,createdAt}`; `GET /shops/:shopId/invites?status&limit&cursor`; `POST /shops/:shopId/invites/:inviteId/resend`; `DELETE /shops/:shopId/invites/:inviteId` → `204`; `POST /shop-invites/accept {token}` → `201 | 200 {shopId, role, alreadyMember?}`.
  - `PUT|GET|DELETE /shops/:shopId/sso` (`PUT {issuer, clientId, clientSecret?, defaultRole?}`); `GET /shops/by-slug/:slug/sso` (anonymous) → `{providerId, displayName}`.
  - `GET /shops/:shopId/export`; `POST /shops/:shopId/offboarding {confirmSlug}`; `DELETE /shops/:shopId/offboarding`.
  - `GET /shop-roles` → `{roles, permissions}`.
  - Platform administrators: `POST /admin/shops/:shopId/suspend {reason}`, `POST /admin/shops/:shopId/reinstate {reason}`, `GET|PUT /admin/shops/:shopId/directory` (`PUT {cell, region, expectedVersion, reason}`).
  - `GET /batch/shops?ids=` (anonymous, public fields only; the BFF's R2 target, S48).
- Guard and decorator `ShopScoped(permission?)` (unchanged name): authenticated + member + permission + status gate; sets `shopId` and role in the request context; `ShopPermission` type and the permission names of FR-020 (additions: `orders.read`, `shop.export`).
- `ShopAccessService` (R1): `assertMember(shopId: ShopId, userId: UserId, permission?: ShopPermission): Promise<{ role: ShopRole }>` (throws not-found / forbidden); `getRole(shopId, userId): Promise<ShopRole | null>`. **Consumers: every domain that currently reads `ShopMembership` (collab/S06 drafts, notifications/S28 routing, launch-events/S23 live, seller-insights/S41, developer-platform/S43), replacing direct reads.**
- `ShopQueryService` (R1): `getShopsByIds(ids: ShopId[]): Promise<Map<ShopId, ShopSummaryDto>>` (≤ 500); `ShopSummaryDto = { id, slug, name, plan, status, verificationStatus, payoutsEnabled, region, isSandbox, sandboxOf: ShopId | null, shopVersion }`. **Consumers: S04, S16, S40, S42, S44, S27, S15, S17 and every domain that joins or selects `Shop` today.**
- `MembershipQueryService` (R1): `getMembersByShopIds(shopIds: ShopId[], roles?: ShopRole[]): Promise<Map<ShopId, { userId: UserId; role: ShopRole }[]>>` (≤ 500). **Consumers: S28 (recipients), S43 (owner/admin alerts), S41 (owners).**
- `ShopProvisioningService` (R1): `ensureShopsForLegacySellers(sellerIds: UserId[]): Promise<Map<UserId, ShopId>>` (≤ 200, idempotent); `ensureSandboxShop(liveShopId: ShopId): Promise<ShopSummaryDto>`. **Consumers: S05 and the chat domain (shop-id backfills), S42 (sandbox).**
- `ShopCellService` (R1): `cellOf(shopId): Promise<{ cell: string; region: string }>`; `TenantConnectionResolver.connectionFor(shopId)` for domains with cell-resident tables (no consumer yet). `ShopTransactionRunner.inShop(shopId, fn)` and `crossTenant(reason: CrossTenantReason, fn)` for shop-private tables of other domains.
- Events (outbox → topic keyed by `shopId`; envelope `{eventId, type, version, occurredAt, aggregateId}`; `shopVersion` is the entity version for read-model version guards, IX.8):
  `tenancy.shop_created` v1 `{shopId, ownerId, name, slug, plan, region, shopVersion}`; `tenancy.shop_updated` v1 `{shopId, name, slug, shopVersion}`; `tenancy.shop_status_changed` v1 `{shopId, from, to, reason?, shopVersion}`; `tenancy.shop_verification_changed` v1 `{shopId, verificationStatus, payoutsEnabled, shopVersion}`; `tenancy.shop_plan_changed` v1 `{shopId, plan, shopVersion}`; `tenancy.member_added` v1 `{shopId, userId, role, source}`; `tenancy.member_role_changed` v1 `{shopId, userId, from, to}`; `tenancy.member_removed` v1 `{shopId, userId, role, reason: 'removed'|'left'|'shop_deleted'}`; `tenancy.invite_created` v1 `{shopId, inviteId, role}`; `tenancy.shop_cell_moved` v1 `{shopId, fromCell, toCell, region, version}`; `tenancy.shop_offboarding_started` v1 `{shopId, purgeAt}`; `tenancy.shop_offboarding_cancelled` v1 `{shopId}`; `tenancy.shop_deleted` v1 `{shopId}`; single-consumer message `tenancy.invite_requested` v1 `{inviteId, shopId, shopName, email, role, token, expiresAt, invitedBy}`.
  **Consumers: S01 (`tenancy.shop_created` → promote a `USER` owner to `SELLER`, conditional and idempotent), S28 (`invite_requested` → mail with the link `<front>/invites/<token>`; offboarding events → mail to owners resolved with `getMembersByShopIds`), S51 (close open subscriptions on `member_removed`), every shop-owning domain (`shop_offboarding_started` → their export; `shop_deleted` → purge; `shop_created`/`shop_updated` → read models of shop name and slug), W04.**
- Rate-limit policies (declared in S50's registry): `tenancy.shop-create.user` 5/hour per user; `tenancy.invite.shop` 20/hour per shop; `tenancy.invite-accept.user` 10 failures/15 min per user and `tenancy.invite-accept.ip` 30/min; `tenancy.sso-lookup.ip` 30/min; `tenancy.shop-write.shop` 120/min per shop on tenancy mutations. All fail-closed.
- Scheduled jobs (registered with S49): `tenancy.purge-deleted-shops` (hourly, ≤ 50 shops per run), `tenancy.purge-expired-invites` (daily, invites expired > 30 days).
- Front-end routes (owned by W04): `/invites/<token>` (page posts the token to accept, then replaces the URL so the token leaves history), shop switcher, team, roles matrix, SSO and offboarding settings.

**Requires**:

- **S01** (`identity`): `UserDirectoryService.getUsersByIds(ids ≤ 500): Map<UserId, {id,email|null,role,createdAt}>` and `findByEmail(email)`; `SessionRevocationService.revokeAllForUser(userId, reason): Promise<number>`; `SecretBox.seal/open(value, context)` with context `shop-sso:<shopId>`; `Firewall({ anonymous?, roles?, sensitive? })`, `@User()`, `AuthenticatedUser = {id, role, sessionId, amr}` (no e-mail); a consumer of `tenancy.shop_created` that promotes `USER` to `SELLER`.
- **S02** (`identity`): `OidcProviderRegistry.registerResolver(prefix: string, resolver)` and `invalidate(providerId)`; `OidcProviderSettings = {issuer, clientId, clientSecret, scope?}`; subject-only trust for `shop:` providers; `POST /auth/oidc/shop:<id>/start`; event `identity.federated_identity_linked` v1 `{userId, provider, linkMethod, passwordInvalidated, mfaReset}` emitted for the first login through a shop provider (including accounts created by it).
- **S04**: events `shop.onboarding_submitted` v1 `{shopId}`, `shop.verified` v1 `{shopId}` and, when it rejects, `shop.rejected` v1 `{shopId}`; it stops updating `Shop` directly.
- **S17**: event `billing.subscription_plan_changed` v1 `{shopId, plan: 'STARTER'|'PRO'|'ENTERPRISE', version}` with a per-shop monotonic `version`.
- **S28**: delivery of the invite and offboarding mails.
- **S49**: single-run scheduled jobs. **S50**: the policies above. **S53**: `outbox.append(event)` in the domain's transaction (IX.6), single-consumer messages, inbox for consumers, DLQ. **S54**: problem+json filter with `code`, request context carrying `shopId`, outbound HTTP port with SSRF guard and timeouts (SSO discovery), config validation, metrics registry, audit logger.
- **S05 and the chat domain**: run their own shop-id backfills through `ShopProvisioningService`, drop their foreign keys to `Shop` and their raw reads of tenancy tables.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a matrix over every shop-scoped endpoint, 100% of attempts by a member of one shop on another shop's resources return "not found" with an identical body and change nothing.
- **SC-002**: After a member is removed, 100% of their sensitive actions fail immediately and 100% of other actions fail within 15 seconds.
- **SC-003**: Across 200 randomized pairs of simultaneous owner demotions and removals, every shop still has at least one owner and exactly one request of each pair succeeds.
- **SC-004**: Of 20 simultaneous attempts to use one invite link, exactly one succeeds; no link is ever visible to the person who sent the invite.
- **SC-005**: A seller can create a shop and have a colleague join through an invite in under 3 minutes of interaction.
- **SC-006**: Moving a shop to its own database cell requires zero changes in any other domain's code or queries, and while that cell is saturated 100% of other shops' requests still succeed within their normal latency.
- **SC-007**: A staff member of a shop with company sign-in reaches the shop with the correct default role in one login, with no invitation.
- **SC-008**: After the purge, 0 personal data items (addresses, user identifiers, secrets) of the shop remain in tenancy storage.
- **SC-009**: Zero queries of any domain other than tenancy touch the five tenancy tables (strict ownership check reports 0 findings for them).

## Assumptions

- Pattern coverage: P0302 → AS-61; P0310 → AS-22–AS-24; P0315 → AS-61, AS-62, FR-055; P0316 → AS-58; P0319 → AS-51–AS-56; P0513 → AS-40–AS-50; P0515 → AS-11, AS-16–AS-19; P0516 → AS-09–AS-15, AS-57–AS-60; P0618 → AS-39, AS-54.
- The platform default region is the configured one (today `eu-central-1`); the allowed list is configuration validated at startup.
- Seat limits (5/25/250), the 7-day invite lifetime, the 30-day grace period, the 10-shop limit, the 15-second authorization cache lifetime, the 5-minute cell cache and the page sizes are fixed defaults of this spec, chosen for the 95%-under-5-members target; they are configuration, not user-editable.
- Slugs are immutable so public URLs and read models never need a rename saga.
- Tenancy tables (including the directory) always live in the pooled control-plane database; only other domains' shop data may live in a dedicated cell.
- A shop's data export for the owner covers tenancy-owned data; each other domain exports its own on `shop_offboarding_started`, and assembling a single bundle is a composition concern outside this spec.
- Financial-record retention after purge is the responsibility of the owning domains reacting to `tenancy.shop_deleted`; tenancy does not veto offboarding.
- E-mail addresses are not proven at registration (S01), which is why invite tokens never reach the inviter and acceptance requires address equality.
- Company SSO does not force other members onto SSO and does not map IdP groups to roles; SCIM is not built.
- Platform-wide administrators are accounts with the `ADMIN` platform role; shop roles never grant platform powers.
- The shop-switcher, team screens and the invite landing page are specified in W04; this spec guarantees only their API contracts.
- Decisions taken without asking are listed in `questions.md`.
