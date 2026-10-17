---
id: optimistic-concurrency
title: Optimistic concurrency (one winner)
kind: term
status: draft
aliases: [simultaneous requests]
defined_for: S05-products
rules_hash: 37f47d190f69
---
# Optimistic concurrency (one winner)
## Definition
[Optimistic concurrency ↗](../sw-external-terms.md#optimistic-concurrency-control) is how [S05](../capabilities/S05-products.md) handles concurrent changes to one product. The server takes no lock while the user is editing. It checks the version only at write time, through [`expectedVersion`](expected-version.md). When several requests carry the same version at the same moment, a single request wins. The others get [`version_conflict`](version-conflict.md). Design intent (not stated in the spec): a product edit can take a long time in a UI, and holding database locks for that whole time would block other writers.

## Example
Two members both read a product at `version: 5`. Both send `PATCH` with `expectedVersion: 5` at the same moment. One gets `200` with `version: 6`. The other gets `409 version_conflict` with `currentVersion: 6`. (Version numbers are illustrative.)

## Known gaps
- Not confirmed in the code: how the database check is done. The facts do not show whether it is a [guarded update](guarded-update.md) on `version` or a [row lock ↗](../sw-external-terms.md#row-lock).

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-02, R-40
- [S02](../capabilities/S02-mfa-oidc.md): R-19
- [S03](../capabilities/S03-shops-rbac.md): R-10
- [S04](../capabilities/S04-kyc-onboarding.md): B-02
- [S05](../capabilities/S05-products.md): R-07
- [S14](../capabilities/S14-ledger-reconciliation.md): R-40
- [S32](../capabilities/S32-product-search.md): R-29
- [directory-row-version](directory-row-version.md)
- [guarded-update](guarded-update.md)
- [mfa-not-pending](mfa-not-pending.md)
- [moderation-task](moderation-task.md)
- [oidc-state](oidc-state.md)
- [order-version](order-version.md)
- [post-auth-refresh](post-auth-refresh.md)
- [put-admin-search-synonyms](put-admin-search-synonyms.md)
<!-- used-by:end -->
