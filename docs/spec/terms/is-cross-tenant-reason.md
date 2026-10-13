---
id: is-cross-tenant-reason
title: isCrossTenantReason
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# isCrossTenantReason
## Definition
`isCrossTenantReason` is the function that checks a stated reason against the [bypass reason allowlist](bypass-reason-allowlist.md). The [cross-tenant bypass](cross-tenant-bypass.md) uses it to decide whether to go ahead. A reason that is not on the allowlist is refused. The check is in the [tenancy domain layer](tenancy-domain-layer.md). Design intent (not stated in the spec): having one function do this check means every caller of the bypass applies the same rule.

## Example
```ts
isCrossTenantReason("some_unlisted_reason") // false, so the bypass is refused (illustrative value)
```
Defined in `packages/backend/libs/domains/tenancy/domain/cross-tenant-reason.ts` (rule S03.R-20, proof S03 AS-59).

## Known gaps
- The spec does not say which reasons are on the allowlist.
- Not confirmed in the code: the exact signature. For example, it may be a TypeScript type guard taking a string and returning a boolean, or it may throw.
- The spec does not say what error or status the caller sees when the bypass is refused.

## Used by
<!-- used-by:start -->
- [bypass-reason-allowlist](bypass-reason-allowlist.md)
- [cross-tenant-bypass](cross-tenant-bypass.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
