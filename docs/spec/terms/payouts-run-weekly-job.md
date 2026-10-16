---
id: payouts-run-weekly-job
title: payouts.run-weekly job
kind: term
status: draft
aliases: [payouts.run-weekly]
defined_for: J01-buy-to-payout
rules_hash: f4b421e4081e
---
# payouts.run-weekly job
## Definition
`[payout](payout-transfer.md)s.run-weekly` is the job that creates payouts from shop balances. It is one of the [allow-listed jobs](job.md) an [operator](operator.md) can run on demand. It creates at most one payout per shop and week. A re-run or an overlapping run changes nothing. A shop below the minimum payout gets no payout, keeps its balance and shows [`blockedReason: "below_minimum"`](blocked-reason.md).

## Example
J01.B-11: with a balance above the minimum, a destination set and 49 hours elapsed, the operator runs `payouts.run-weekly`. One payout is paid, and the owner holds one `payout.paid` notice.
J01.B-12: the run is requested again, or twice at once. Each job ends `SUCCEEDED`, with no second payout, transfer or notice.

## Known gaps
- The spec does not say when the job runs on its own schedule, or what the 49 hours elapsed in the test stand for.
- The spec does not state the minimum payout amount or the definition of the payout "week".
- The spec mentions a separate "send job" after the run (J01.B-13) but does not name it. It also does not say how the work is split between that job and the run.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
