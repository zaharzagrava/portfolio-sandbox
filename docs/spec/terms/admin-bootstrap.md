---
id: admin-bootstrap
title: Admin bootstrap
kind: term
status: draft
aliases: []
defined_for: J02-seller-to-first-sale
rules_hash: 0fce1c2cfe42
---
# Admin bootstrap
## Definition
The admin bootstrap is local-stack configuration that the [J02 journey](main-journeys.md) lists among the things it relies on. Several journey steps need a [platform admin](platform-admin.md). An admin resolves [document review tasks](moderation-task.md), rejects applications and suspends or reinstates shops. Design intent (not stated in the spec): the bootstrap provides that admin account on a fresh stack, so the journey can act as admin without a manual step.

## Example
In J02 [AS-08](acceptance-scenario.md), the [extractor](extraction-worker.md) routes a forged document to review. An admin resolves the task with [`REJECT_APPLICATION`](recorded-decision.md), and the shop ends with `[verificationStatus](shop-verification.md): "REJECTED"` and `[payoutsEnabled](payouts-enabled.md): false`. In AS-22, an admin suspends the shop and its products leave search.

## Known gaps
- The spec does not say what the bootstrap creates, which credentials it uses, or how the journey test signs in as that admin.
- Not confirmed in the code: no file for the admin bootstrap is listed. The facts also do not say whether it runs only locally or in other environments too.

## Used by
<!-- used-by:start -->
- [local-provider-doubles](local-provider-doubles.md)
- [webhook-receiver-allow-list](webhook-receiver-allow-list.md)
<!-- used-by:end -->
