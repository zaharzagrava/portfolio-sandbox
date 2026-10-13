---
id: shopless-job
title: Shopless job
kind: term
status: draft
aliases: [job without a shop, jobs without a shop]
defined_for: job-scheduler-lease
rules_hash: a3aac515bad3
---
# Shopless job
## Definition
A shopless job is a job that belongs to no shop. The per-shop cap never limits it, so it can be claimed no matter how many jobs any shop is running. Apart from that, it follows the same rules as any other job: status, lease, retries and the reaper.

## Example
Shop A has reached its per-shop cap. A queued shopless job can still be claimed by a free worker straight away. A recurring job such as `recommendations.build-bought-together` may be shopless, but the facts do not confirm this, so treat it only as an illustration.

## Known gaps
- The spec does not say how enqueue marks a job as shopless, for example by leaving out a shop id.
- The spec does not say whether any other limit applies to shopless jobs. Many shopless jobs at once could still use up the workers and starve shop jobs.
- Not confirmed in the code: which jobs from S13, S32 and S34 are shopless.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-15
- [per-shop-running-cap](per-shop-running-cap.md)
- [search-retire-previous-index](search-retire-previous-index.md)
<!-- used-by:end -->
