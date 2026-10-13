---
id: bypass-reason-allowlist
title: Bypass reason allowlist
kind: term
status: draft
aliases: [allowlisted reason]
defined_for: S03-shops-rbac
rules_hash: 3b8ef274123f
---
# Bypass reason allowlist
## Definition
The bypass reason allowlist is the fixed set of reasons that the [cross-tenant bypass](cross-tenant-bypass.md) accepts. Any reason outside this set is refused. [`isCrossTenantReason`](is-cross-tenant-reason.md) makes the check. Design intent (not stated in the spec): each [cross-tenant read](cross-tenant-bypass.md) must state an approved purpose, so a cross-tenant read cannot happen by accident or with no reason given.

## Example
```ts
isCrossTenantReason("some_unlisted_reason") // false → bypass refused (illustrative value)
```
The check lives in `packages/backend/libs/domains/tenancy/domain/cross-tenant-reason.ts`.

## Known gaps
- The spec does not say which reasons are on the allowlist.
- The spec does not say how a new reason is added or who approves it.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-20
- [cross-tenant-bypass](cross-tenant-bypass.md)
- [is-cross-tenant-reason](is-cross-tenant-reason.md)
<!-- used-by:end -->
