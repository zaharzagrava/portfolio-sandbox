---
id: recipient-rule
title: Recipient rule
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: f760a7f839d6
---
# Recipient rule
## Definition
A recipient rule is the part of a [catalog entry](notification-catalog.md) that says who receives a notification of that type. When an event is [routed](notification-routing.md), the rule decides which users, or which e-mail address, get a [notification request](notification-queue.md). Users are looked up only through the [exported services](exported-service.md) of identity and tenancy. A user who cannot be found receives nothing.

## Example
An invitation from the [`tenancy-invite-requested` queue](tenancy-invite-requested-queue.md) goes to an e-mail address. It gets the [e-mail line](email-line.md) only, with no [inbox item](inbox-item.md) and no [preference lookup](preference-lookup.md). A shop-level type might name the shop's members as recipients (illustrative).

## Known gaps
- The spec does not list the kinds of recipient rule, or say how each one maps to identity and tenancy calls.
- The spec does not say what happens when a rule matches no recipients, other than that an unknown user produces nothing.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-50
- [email-line](email-line.md)
- [exported-service](exported-service.md)
- [inbox-item](inbox-item.md)
- [notification-catalog](notification-catalog.md)
- [notification-queue](notification-queue.md)
- [notification-routing](notification-routing.md)
- [preference-lookup](preference-lookup.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
<!-- used-by:end -->
