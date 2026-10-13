---
id: checkpoint-lookup
title: Checkpoint lookup
kind: term
status: draft
aliases: [checkpoint]
defined_for: tenant-shop-rbac
rules_hash: 8cda6689f506
---
# Checkpoint lookup
## Definition
A checkpoint lookup is a step in [S53](../capabilities/S53-events-projections.md) that can run when a caller reads an [aggregate](aggregate-id.md) and passes [`minVersion`](min-version.md). [Tenant isolation](tenant.md) is checked before it. If the caller's tenant does not own the aggregate, the caller gets `404` and no checkpoint lookup runs. Running no lookup means the answer reveals nothing about the other tenant's aggregate or how far it has progressed. That is design intent (not stated in the spec). It probably checks whether a [projection ↗](../sw-external-terms.md#projection) has reached the requested `minVersion` for [read-your-writes](read-your-writes.md), but the facts do not confirm this.

## Example
Tenant B reads an aggregate that belongs to tenant A and passes `minVersion=1`. Tenant B gets `404` and no checkpoint lookup runs (S53.B-19).

## Known gaps
- The spec does not say what a checkpoint lookup reads or returns, or what happens when the checkpoint is behind `minVersion`.
- The spec does not say whether the lookup runs on reads that have no `minVersion`.
- Not confirmed in the code: that the tenant check runs before the lookup in every read path, not only the path in S53.B-19.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-20
- [S53](../capabilities/S53-events-projections.md): B-07, B-19
- [aggregate-id](aggregate-id.md)
- [read-wait-timeout](read-wait-timeout.md)
- [read-your-writes](read-your-writes.md)
- [resumable-fan-out](resumable-fan-out.md)
- [shop-not-found](shop-not-found.md)
- [tenant](tenant.md)
<!-- used-by:end -->
