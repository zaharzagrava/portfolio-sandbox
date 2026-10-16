---
id: tenant-shop-rbac
title: Shops as tenants and roles
kind: concept
status: draft
defined_by: S03
---
# Shops as tenants and roles
## Definition
A shop is the tenant of the marketplace: a seller organisation with a team, a plan and a status. This concept decides who may do what inside a shop and keeps shops apart. It guarantees that one shop never sees or disturbs another. A non-member gets the same answer as for a missing shop. Each role has a fixed set of permissions. Other capabilities rely on membership, role and tenant isolation.

## Rules
- **[tenant](../terms/tenant.md)-shop-rbac.C-01** A non-member, an unknown shop, a malformed identifier and a deleted shop MUST all answer the same [`404 shop_not_found`](../terms/shop-not-found.md); the same rule applies to reads of another [tenant's aggregate](../terms/aggregate-id.md).
- **tenant-shop-rbac.C-02** The shop MUST come from the path or the [`X-Shop-Id` header](../terms/x-shop-id-header.md), never from the body; a path and header that differ MUST answer [`400 shop_mismatch`](../terms/shop-mismatch.md).
- **tenant-shop-rbac.C-03** Answers MUST follow this order: [`401 invalid_token`](../terms/invalid-token-error.md), `404`, [`403 permission_denied`](../terms/permission-denied.md), then the [status gate](../terms/shop-status-gate.md). A [`SUSPENDED`](../terms/shop-status.md) shop MUST allow only `shop.read`, `members.read` and [`shop.export`](../terms/permission.md).
- **tenant-shop-rbac.C-04** The [permissions](../terms/permission.md) of each [role](../terms/shop-role.md) MUST equal the [matrix of FR-020](../terms/role-permission-matrix.md), and a lower role MUST hold a subset of the permissions of the adjacent higher role. An unknown role or permission MUST be denied.
- **tenant-shop-rbac.C-05** Only an [`OWNER`](../terms/shop-role.md) MAY assign, change or remove `OWNER` or `ADMIN`; an `ADMIN` MAY manage `STAFF` and `VIEWER` only. Violations MUST answer [`403 insufficient_role`](../terms/insufficient-role.md).
- **tenant-shop-rbac.C-06** A shop MUST always keep at least one `OWNER`; a change that removes the last one MUST answer [`409 last_owner`](../terms/last-owner.md), also under [concurrent changes ↗](../sw-external-terms.md#race-condition).
- **tenant-shop-rbac.C-07** [Tenancy tables](../terms/tenancy-tables.md) MUST be unreadable without a tenant set, and the [tenant setting](../terms/tenant-setting.md) MUST NOT leak between [transactions ↗](../sw-external-terms.md#database-transaction) on one connection.
- **tenant-shop-rbac.C-08** [Seats used](../terms/seat.md) (members plus [unexpired pending invites](../terms/pending-invite.md)) MUST NOT exceed the [plan limit](../terms/plan-limit.md): `STARTER` 5, `PRO` 25, `ENTERPRISE` 250.

## How the capabilities use it
- {{cap:S03}} defines the concept: memberships, roles, permissions, invites, plan seat limits, slugs, and the tenant isolation of data.
- {{cap:S05}} relies on shop membership to let members create, edit, list, archive and restore products.
- {{cap:S53}} relies on tenant isolation: tenant B reading an aggregate of tenant A with `minVersion=1` gets `404` and no checkpoint lookup (S53.B-19).

## Known gaps
- S32, S50 and S51 list this concept but no line links it; their use is not stated.
- S05 and S53 give only one line each, so the exact permissions they need are not stated.
- The permission matrix of FR-020 was not given.

## Used by
<!-- used-by:start -->
- {{cap:J01}} Buyer pays for a multi-shop order; order paid → ledger journals → settlement → seller payout → monthly statement; buyer and sellers notified
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S17}} Subscriptions - plans, versioned prices, state machine, billing run, charging and dunning, proration, credit
- {{cap:S18}} Usage metering (late events, adjustments) and entitlement checks
- {{cap:S21}} Limited-drop auctions (proxy bids, anti-sniping, reserve, exactly-once close, second chance, shill guard)
- {{cap:S24}} Product chat (channels, idempotent send, per-channel sequence, sync on reconnect, unread, receipts, presence, offline push)
- {{cap:S29}} Product and review photos (upload, safe processing, duplicate flag, galleries, cleanup)
- {{cap:S30}} Product video and VOD (resumable upload, transcoding graph, HLS ladder, signed delivery)
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S42}} Seller public API: API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch and bulk stock, request logs, usage metering
- {{cap:S43}} Webhook delivery to shops: endpoints, signing with dual secrets, routing, per-endpoint ordering, retries, circuit breaker, auto-disable, replay
- {{cap:S44}} Embeddable storefront widget: site keys bound to origins, per-site framing policy, identity hand-off, kill switch
- {{cap:S50}} Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
- {{cap:S51}} Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
<!-- used-by:end -->
