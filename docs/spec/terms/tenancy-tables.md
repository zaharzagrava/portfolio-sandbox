---
id: tenancy-tables
title: Tenancy tables
kind: term
status: draft
aliases: [tenancy table]
defined_for: tenant-shop-rbac
rules_hash: 84a0675216e3
---
# Tenancy tables
## Definition
Tenancy tables are the database tables that hold per-shop data, where [tenant isolation](tenant.md) is enforced in the database itself. Under rule C-07, nothing can be read from them unless the current shop has been named and is [active for the current transaction](active-transaction.md). This backs up the [API-level checks](permission.md): a query that forgets to filter by shop still cannot see another shop's rows.

## Example
A worker opens a transaction and queries a tenancy table without setting the tenant. The read must return nothing or fail. It must never return rows from every shop.

## Known gaps
- The spec does not say which tables count as tenancy tables.
- Not confirmed in the code: the mechanism that blocks reads. Database [row-level security ↗](../sw-external-terms.md#row-level-security) is the usual technique, but the facts do not name it.
- The spec does not say whether a read without a tenant returns zero rows or raises an error.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-19
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-07
- [active-transaction](active-transaction.md)
- [cross-tenant-bypass](cross-tenant-bypass.md)
- [permission](permission.md)
- [shop-guard](shop-guard.md)
- [shop-sso-config](shop-sso-config.md)
- [slug-policy](slug-policy.md)
- [tenant-setting](tenant-setting.md)
- [tenant](tenant.md)
<!-- used-by:end -->
