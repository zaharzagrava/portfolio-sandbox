---
id: duplicate-triggers
title: Duplicate triggers
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: 97f6836f3563
---
# Duplicate triggers
## Definition
Duplicate triggers are repeated attempts to start the same piece of work, here the closing of one auction. They can come from a job that runs more than once or from a [close job](close-job.md) left over after the end moved. Closing must stay correct under them. Whatever the number of triggers, there is one close and one set of results. Guarding against them is the job of the [conditional transition](conditional-transition.md).

## Example
A bid lands inside the [anti-sniping window](anti-sniping-window.md), so [`endsAt`](ends-at.md) moves later. The original [`auctions.close`](auctions-close-job.md) job still fires and does nothing (J03 AS-30). When the new end passes, closing produces exactly one [`auction.closed`](auction-closed-event.md).

## Known gaps
- The spec does not list every source of duplicate triggers, for example job retries or a [lease](job-lease.md) that expires mid-run.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-10
- [anti-sniping-window](anti-sniping-window.md)
- [auction-closed-event](auction-closed-event.md)
- [auction-won-notice](auction-won-notice.md)
- [auctions-close-job](auctions-close-job.md)
- [award-notice](award-notice.md)
- [close-job](close-job.md)
- [conditional-transition](conditional-transition.md)
- [job-lease](job-lease.md)
- [winner-order](winner-order.md)
<!-- used-by:end -->
