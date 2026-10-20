---
id: ends-at
title: endsAt
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# endsAt
## Definition
`endsAt` is the time an auction is due to end. When that time passes, the [close job](close-job.md) closes the auction. A bid inside the [anti-sniping window](anti-sniping-window.md) moves `endsAt` later. Time is read from the [injected clock](injected-clock.md), so tests can make an auction due without waiting.

## Example
```json
{ "endsAt": "2026-10-19T20:05:00Z" }
```
Illustrative value: an earlier `endsAt` of 20:00 was moved to 20:05 after [a late bid](anti-sniping-window.md).

## Known gaps
- The spec does not say which response or event exposes `endsAt` to buyers.
- The spec does not say whether moving `endsAt` emits an event or a notice.

## Used by
<!-- used-by:start -->
- [anti-sniping-window](anti-sniping-window.md)
- [close-job](close-job.md)
- [injected-clock](injected-clock.md)
<!-- used-by:end -->
