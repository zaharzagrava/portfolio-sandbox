---
id: cross-tenant-bypass
title: Cross-tenant bypass
kind: term
status: draft
aliases: [bypass]
defined_for: S03-shops-rbac
rules_hash: 4616faf16dca
---
# Cross-tenant bypass
## Definition
The cross-tenant bypass is a controlled way to read [tenancy tables](tenancy-tables.md) without a single [tenant setting](tenant-setting.md). Normally those tables cannot be read until a tenant is set. The bypass accepts a call only when the caller gives one of a fixed set of approved reasons. When the database role has [superuser or bypass rights ↗](../sw-external-terms.md#row-level-security), production start fails. Design intent (not stated in the spec): the database's own [tenant isolation](tenant.md) should never be skipped silently.

## Example
Code checks a requested reason with `isCrossTenantReason` before it reads shop rows across tenants. A reason that is not on the list is refused. A production deploy whose database role has superuser rights does not start.

## Known gaps
- The spec does not say which code paths or capabilities may use the bypass.
- The spec does not say whether bypass use is logged or audited.
- Not confirmed in the code: how the bypass interacts with the tenant setting for each transaction (cleared, replaced or marked).

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-20
- [bypass-reason-allowlist](bypass-reason-allowlist.md)
- [is-cross-tenant-reason](is-cross-tenant-reason.md)
- [shop-provisioning-service](shop-provisioning-service.md)
- [shop-query-service](shop-query-service.md)
- [tenancy-tables](tenancy-tables.md)
- [tenant-setting](tenant-setting.md)
- [tenant](tenant.md)
<!-- used-by:end -->
