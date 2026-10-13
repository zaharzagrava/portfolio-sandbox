---
id: tenancy-purge-deleted-shops-job
title: tenancy.purge-deleted-shops job
kind: term
status: draft
aliases: [tenancy.purge-deleted-shops]
defined_for: S03-shops-rbac
rules_hash: 11ed20436951
---
# tenancy.purge-deleted-shops job
## Definition
`tenancy.purge-deleted-shops` is the scheduled job that runs the [shop purge](shop-purge.md). It runs on a fixed schedule and picks up every [due shop](shop-purge-due.md). It purges each due shop once, in a separate transaction, and leaves a [shop tombstone](shop-tombstone.md) behind. Design intent (not stated in the spec): with one transaction per shop, a failure on one shop does not undo the purge of the other shops in the same run. It is one of several tenancy jobs, together with the [invite purge job](invite-purge-job.md).

## Example
An owner closes a shop through [`POST /shops/:shopId/offboarding`](shop-offboarding.md). Later the shop becomes due. On the next hourly run, `tenancy.purge-deleted-shops` purges it. The shop is now `DELETED` with the name `[deleted]` and the slug `deleted-<id>`. The job publishes [`tenancy.member_removed`](member-removed-event.md) (reason `shop_deleted`) and [`tenancy.shop_deleted`](shop-deleted-event.md).

## Known gaps
- The spec does not say what happens when the purge of one shop fails, for example whether the next run tries that shop again.
- The spec does not say what the job's [cron overlap policy](cron-overlap-policy.md) is, so it is unclear whether two runs can overlap.
- Not confirmed in the code: how the job selects due shops. The facts only point to `PurgeShopsJobs` and `ShopLifecycleService`.

## Used by
<!-- used-by:start -->
- [cron-overlap-policy](cron-overlap-policy.md)
- [invite-purge-job](invite-purge-job.md)
- [purge-at](purge-at.md)
- [shop-purge-due](shop-purge-due.md)
- [shop-purge](shop-purge.md)
- [shop-tombstone](shop-tombstone.md)
<!-- used-by:end -->
