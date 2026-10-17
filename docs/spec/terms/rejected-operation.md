---
id: rejected-operation
title: Rejected operation
kind: term
status: draft
aliases: [rejected operations]
defined_for: S04-kyc-onboarding
rules_hash: 43fed765470a
---
# Rejected operation
## Definition
Any [onboarding request](onboarding-submit.md) that the capability refuses with an error answer, such as a 4xx validation, conflict or [rate-limit error](rate-limited.md). A rejected operation appends no [event](event-envelope.md) and persists nothing. This is different from a reviewer *rejecting* a document or application, which is a successful operation that does publish an event. Design intent (not stated in the spec): consumers never react to something that did not happen.

## Example
A moderator approves a task, but the IBAN fails the [hard check](hard-checks.md). The answer is [`422 iban_invalid`](iban-invalid.md). The document stays in [`NEEDS_REVIEW`](document-status.md), and no [`shop.verified`](shop-verified-event.md) or other event is appended.

## Known gaps
- The spec does not say whether rejected operations are recorded in [`OnboardingStatusHistory`](onboarding-status-history.md) or in an [audit log](audit-log.md).
- The spec does not define which [late results](late-result.md) are ignored by a [`VERIFIED` application](onboarding-application-status.md), beyond saying it stays unchanged.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-27
<!-- used-by:end -->
