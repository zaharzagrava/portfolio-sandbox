---
id: tenant
title: Tenant
kind: term
status: draft
aliases: [tenants, x-tenant-id]
defined_for: idempotency-key
rules_hash: f6e1efcb46ac
---
# Tenant
## Definition
A tenant is one customer of this multi-customer platform. The platform keeps each tenant's data and work separate from other tenants. Requests carry the tenant as one of the [identity headers](identity-headers.md) (`X-Tenant-Id`). The rules for sharing workers between waiting jobs may use the tenant as the unit they share workers between. Design intent (not stated in the spec): if they do, one tenant's large burst of jobs should not make other tenants' jobs wait.

## Example
A request forwarded inside the platform carries the caller's tenant in the identity headers:
```
X-Tenant-Id: tenant-123   (illustrative value)
```

## Known gaps
- The spec does not say how a tenant relates to a [shop](shop-order.md), for example whether one tenant can own several shops.
- The spec does not say whether job fairness in [S49](../capabilities/S49-job-scheduler.md) uses the tenant as its unit.
- Not confirmed in the code: the format of a tenant id, or where it is checked.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-19
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md)
- [checkpoint-lookup](checkpoint-lookup.md)
- [connection-routing](connection-routing.md)
- [cross-tenant-bypass](cross-tenant-bypass.md)
- [identity-headers](identity-headers.md)
- [job-fairness](job-fairness.md)
- [legacy-seller](legacy-seller.md)
- [shop-order](shop-order.md)
- [shop-tenant](shop-tenant.md)
- [tenancy-tables](tenancy-tables.md)
<!-- used-by:end -->
