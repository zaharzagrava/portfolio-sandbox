---
id: onboarding-draft-lifetime
title: Onboarding draft lifetime
kind: term
status: draft
aliases: [draft]
defined_for: S04-kyc-onboarding
rules_hash: f3bb2527066d
---
# Onboarding draft lifetime
## Definition
The draft lifetime is how long a not-yet-submitted [questionnaire draft](onboarding-draft.md) is kept. Every [step save](onboarding-step.md) resets it to its full length, so an active seller does not lose their answers. The draft exists only before submission. Once submitted, the answers become an [onboarding row](onboarding-row.md) instead.

## Example
A seller saves [`business`](onboarding-questionnaire.md) on day 1 and `tax` on day 5. The second save restarts the draft lifetime from day 5, so the 7-day lifetime now runs until day 12.

## Known gaps
- The spec does not say what happens when the lifetime runs out. It is not stated whether the draft is deleted, or whether the view goes back to [`NOT_STARTED`](onboarding-application-status.md).
- The spec does not say where the draft is stored. It only says it is not a relational row.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-02, R-06
<!-- used-by:end -->
