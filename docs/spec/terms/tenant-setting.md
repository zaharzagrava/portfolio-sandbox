---
id: tenant-setting
title: Tenant setting
kind: term
status: draft
aliases: [tenant set]
defined_for: tenant-shop-rbac
rules_hash: d855f5d69f32
---
# Tenant setting
## Definition
The tenant setting is the value that tells the database which [shop](shop-tenant.md) the current [transaction ↗](../sw-external-terms.md#database-transaction) acts for. [Tenancy tables](tenancy-tables.md) are unreadable until it is set. It must be scoped to one transaction. When connections are [pooled and reused ↗](../sw-external-terms.md#connection-pool), the next transaction on the same connection must not inherit the previous shop. Design intent (not stated in the spec): a leaked setting would let one request read another shop's data, breaking the guarantee that one shop never sees another.

## Example
Request 1 for shop A sets the tenant, runs its queries and commits. Request 2 for shop B then reuses the same pooled connection. It must start with no tenant set, not with shop A.

## Known gaps
- Not confirmed in the code: how the setting is stored and cleared, for example a transaction-local database variable.
- The spec does not say how the setting relates to the [request context](request-context.md) or the [`X-Shop-Id` header](x-shop-id-header.md). Rule C-02 only says the shop comes from the path or that header.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-19
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-07
- [cross-tenant-bypass](cross-tenant-bypass.md)
- [request-context](request-context.md)
- [shop-guard](shop-guard.md)
- [shop-tenant](shop-tenant.md)
- [tenancy-tables](tenancy-tables.md)
- [x-shop-id-header](x-shop-id-header.md)
<!-- used-by:end -->
