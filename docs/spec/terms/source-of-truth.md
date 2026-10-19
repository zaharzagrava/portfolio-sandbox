---
id: source-of-truth
title: Source of truth
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: d8866b4fbbbe
---
# Source of truth
## Definition
The source of truth is the store whose data counts when two copies disagree. In this capability it is the database, not the fast in-memory copy of access decisions. A [cache entry](cache-entry.md) is only a short-lived copy of what the database says. Writers commit to the database first and then delete the affected cache entries, and [sensitive permissions](permission.md) always skip the cache and read the database. The reason is design intent (not stated in the spec): a stale or lost entry must never decide access on its own.

## Example
An owner demotes a member with `PATCH /shops/:shopId/members/:userId` and gets `204`. The database now holds the new role, and that member's cache entry is [dropped after the commit](after-commit-callback.md). On their next request, [the cache misses](cache-miss.md) and the role is read again from the database. If the drop were missed, the old entry would still end within 15 s (10 s for a [negative entry](negative-caching.md)).

## Known gaps
- The spec does not say which permissions count as "sensitive" and always read the database.
- The spec does not say which tenancy table holds the authoritative role. [`ShopMembership`](shop-membership.md) is the likely one going by its name, but that is not confirmed.
- Not confirmed in the code: the facts include no code reference for the cache, for the delete after commit, or for the database read on sensitive permissions.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-15
- [after-commit-callback](after-commit-callback.md)
- [authorization-cache](authorization-cache.md)
- [cache-entry](cache-entry.md)
- [cache-miss](cache-miss.md)
- [negative-caching](negative-caching.md)
- [optimistic-update](optimistic-update.md)
- [permission](permission.md)
- [read-model](read-model.md)
- [rebuildable-read-model](rebuildable-read-model.md)
- [write-model](write-model.md)
<!-- used-by:end -->
