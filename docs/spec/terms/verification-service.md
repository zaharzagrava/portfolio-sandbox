---
id: verification-service
title: VerificationService
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# VerificationService
## Definition
`VerificationService` is the tenancy [application service ↗](../sw-external-terms.md#application-service) that owns a shop's verification status and its [`payoutsEnabled`](payouts-enabled.md) flag. It applies the [`shop.onboarding_submitted`](shop-onboarding-submitted-event.md), [`shop.verified`](shop-verified-event.md) and [`shop.rejected`](shop-rejected-event.md) events through the [lifecycle state machine ↗](../sw-external-terms.md#state-machine). No other path may change these two fields. Applying the same event twice changes nothing. If a decision arrives before the submission, the shop stays decided.

## Example
`POST /shops` creates a shop with verification `UNVERIFIED` and `payoutsEnabled` false. If `shop.verified` arrives for that shop, `VerificationService` applies the decision. If `shop.onboarding_submitted` then arrives late, the shop keeps its decided state. A redelivered `shop.verified` changes nothing.

Code: `packages/backend/libs/domains/tenancy/application/verification.service.ts#VerificationService` (rule S03.R-28).

## Known gaps
- The spec does not say which verification status values each event sets. It only names `UNVERIFIED` as the starting value.
- The spec does not say which event, if any, turns `payoutsEnabled` on or off.
- The spec does not say how a repeated event is detected, for example by a state check or an inbox record. It also does not say whether other capabilities can call this service, because it is not in the exported services list.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
