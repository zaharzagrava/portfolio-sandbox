---
id: onboarding-verify-pending-job
title: onboarding.verify-pending job
kind: term
status: draft
aliases: [onboarding.verify-pending]
defined_for: J02-seller-to-first-sale
rules_hash: e3b0c44298fc
---
# onboarding.verify-pending job
## Definition
`onboarding.verify-pending` is a [scheduled sweep job](job.md) that repairs one specific crash gap in onboarding. If the system crashes after all documents are approved but before the shop is marked verified, this job finishes the step. It appends [`shop.verified`](shop-verified-event.md) once for such a shop, so the shop does not stay unverified forever. [Tenancy](tenancy-domain-layer.md) then derives [`verificationStatus`](shop-verification.md) from that event as usual.

## Example
A seller's documents are all approved, then the process crashes before `shop.verified` is appended. On its next run, `onboarding.verify-pending` finds the shop and appends one `shop.verified`, and the shop becomes verified (scenario AS-11).

## Known gaps
- The spec does not say how often the job runs, so the delay before repair is unknown.
- The spec does not say how the job finds affected shops or how it guarantees "once" (for example, a [guarded update](guarded-update.md) or a check on existing events).
- Not confirmed in the code: the facts give no code excerpt for AS-11 beyond the scenario text.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
