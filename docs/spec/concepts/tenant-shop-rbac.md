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
- **tenant-shop-rbac.C-01** A non-member, an unknown shop, a malformed identifier and a deleted shop MUST all answer the same `404 shop_not_found`; the same rule applies to reads of another tenant's aggregate.
- **tenant-shop-rbac.C-02** The shop MUST come from the path or the `X-Shop-Id` header, never from the body; a path and header that differ MUST answer `400 shop_mismatch`.
- **tenant-shop-rbac.C-03** Answers MUST follow this order: `401 invalid_token`, `404`, `403 permission_denied`, then the status gate. A `SUSPENDED` shop MUST allow only `shop.read`, `members.read` and `shop.export`.
- **tenant-shop-rbac.C-04** The permissions of each role MUST equal the matrix of FR-020, and a lower role MUST hold a subset of the permissions of the adjacent higher role. An unknown role or permission MUST be denied.
- **tenant-shop-rbac.C-05** Only an `OWNER` MAY assign, change or remove `OWNER` or `ADMIN`; an `ADMIN` MAY manage `STAFF` and `VIEWER` only. Violations MUST answer `403 insufficient_role`.
- **tenant-shop-rbac.C-06** A shop MUST always keep at least one `OWNER`; a change that removes the last one MUST answer `409 last_owner`, also under concurrent changes.
- **tenant-shop-rbac.C-07** Tenancy tables MUST be unreadable without a tenant set, and the tenant setting MUST NOT leak between transactions on one connection.
- **tenant-shop-rbac.C-08** Seats used (members plus unexpired pending invites) MUST NOT exceed the plan limit: `STARTER` 5, `PRO` 25, `ENTERPRISE` 250.

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
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S50}} Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
- {{cap:S51}} Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
<!-- used-by:end -->
