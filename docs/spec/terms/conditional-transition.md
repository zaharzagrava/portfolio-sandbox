---
id: conditional-transition
title: Conditional transition
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: 140d6d5b84c0
---
# Conditional transition
## Definition
A conditional transition is a state change that applies only if the auction is still in the state the change expects. Closing an auction is done as one such transition. If the condition no longer holds, because another run already closed it or the end moved, the change does nothing. This makes the close safe to run more than once. Applying the check and the change in one step, so two runs cannot both pass, is design intent (not stated in the spec).

## Example
The job [`auctions.close`](auctions-close-job.md) fires for an auction whose end has passed. The first run moves it to `CLOSED` and produces one [`auction.closed`](auction-closed-event.md), one [winner order](winner-order.md) and one [`auction.won`](auction-won-notice.md) notice. A second run finds the auction already `CLOSED` and changes nothing.

## Known gaps
- The spec does not say which state the auction must be in before closing. The lifecycle on the page starts at `CLOSED`.
- Not confirmed in the code: how the condition is enforced, for example a [guarded update](guarded-update.md) or a version check.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
