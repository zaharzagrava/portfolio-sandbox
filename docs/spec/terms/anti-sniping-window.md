---
id: anti-sniping-window
title: Anti-sniping window
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: d9ed3ab50db3
---
# Anti-sniping window
## Definition
The anti-sniping window is a period just before an auction's [`endsAt`](ends-at.md). A bid placed inside this window moves `endsAt` later. The [close job](close-job.md) that was due at the original end then does nothing. Design intent (not stated in the spec): this gives other bidders time to respond to a last-second bid.

## Example
An auction ends at 20:00 (illustrative). A bid arrives at 19:59, inside the anti-sniping window. `endsAt` moves later, and the [`auctions.close`](auctions-close-job.md) run due at 20:00 changes nothing.

## Known gaps
- The spec does not say how long the window is or how far `endsAt` moves.
- The spec does not say whether the window applies again after each extension, or whether there is a limit on extensions.
- Not confirmed in the code: how the original close job detects that `endsAt` has moved.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
