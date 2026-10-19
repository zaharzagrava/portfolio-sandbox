---
id: admission-token
title: Admission token
kind: term
status: draft
aliases: [admission_required]
defined_for: J03-launch-day
rules_hash: 8c4585c0b9dc
---
# Admission token
## Definition
An admission token is the pass a buyer receives after waiting in the [queue](buyer-queue.md) of a [launch event](launch-event.md). The buyer must present it to [hold seats](seat-hold.md). It is bound to exactly one launch event and one buyer. The [hold route](seat-hold.md) refuses an [ordinary access token](access-token.md), another event's admission token, or another buyer's admission token with `403 ADMISSION_REQUIRED`. Design intent (not stated in the spec): the token keeps buyers who skipped the queue from holding seats.

## Example
Twelve buyers wait in a launch event's queue. When sales open the [admitter](admitter.md) runs, and each buyer receives a ticket. Each buyer then holds seats with their own admission token and confirms the hold (J03.B-01). If buyer A sends buyer B's token to the hold route, the answer is `403 ADMISSION_REQUIRED`.

## Known gaps
- The spec does not say the token's format, its lifetime, or how the hold route receives it (header, cookie or body).
- The spec does not name the hold route or the queue route. No route is confirmed in the facts.
- The spec does not turn the privacy requirement (no admission token inside events, FR-029/FR-030) into a rule.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
