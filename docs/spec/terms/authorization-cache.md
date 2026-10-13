---
id: authorization-cache
title: Authorization cache
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# Authorization cache
## Definition
The authorization cache keeps access data, such as a member's role in a shop, in [the shared store](l2-cache.md). Most permission checks can then skip the database. This is design intent (not stated in the spec). The cache is never the [source of truth](source-of-truth.md): every entry expires after a short lifetime, and ["not a member" answers are cached](negative-caching.md) for an even shorter time. [Writers delete the affected entries](invalidation-only-writes.md) after their transaction commits, and never write new values into the cache. [Sensitive permissions](sensitive-route.md) are always checked against the database and never against the cache.

## Example
An owner demotes a member with `PATCH /shops/:shopId/members/:userId` and gets `204`. After the commit, that member's [cache entry](cache-entry.md) is deleted, so their next request loads the new role from the database. If the delete were missed, the stale entry would still end within 15 s (10 s for a negative entry).

## Known gaps
- The spec does not say which permissions count as "sensitive" and always read the database.
- The spec does not say what a cache entry holds or how its key is built (for example, per user and shop).
- Not confirmed in the code: the facts include no code reference for the cache or for the delete after commit.

## Used by
<!-- used-by:start -->
- [cache-entry](cache-entry.md)
- [invalidation-only-writes](invalidation-only-writes.md)
- [l2-cache](l2-cache.md)
- [membership-query-service](membership-query-service.md)
- [my-role](my-role.md)
- [negative-caching](negative-caching.md)
- [sensitive-route](sensitive-route.md)
- [shop-access-service](shop-access-service.md)
- [source-of-truth](source-of-truth.md)
<!-- used-by:end -->
