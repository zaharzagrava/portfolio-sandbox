---
id: seat-hold-expired
title: HOLD_EXPIRED (409)
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# HOLD_EXPIRED (409)
## Definition
`409 HOLD_EXPIRED` is the answer to a [hold](seat-hold.md) confirmation when the hold has already passed its expiry. When a hold expires unconfirmed, its seats are freed for other buyers. A confirmation that arrives after expiry creates no booking, no event, no notice and no [voucher](voucher.md). Expiry is measured by the [injected clock](injected-clock.md), so tests can make a hold due without waiting.

## Example
B-05: a buyer holds a seat and does not confirm it within 10 minutes. The seat is free again, and the buyer's late confirm answers `409 HOLD_EXPIRED`.

## Known gaps
- The spec does not say whether `HOLD_EXPIRED` is the [`code` member](error-code.md) of a [problem body](problem-body.md). It is upper-case, unlike most other error codes.
- The spec does not say whether the buyer can create a new hold on the same seats after this answer.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
