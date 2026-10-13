---
id: exported-service
title: Exported service
kind: term
status: draft
aliases: [exported services]
defined_for: S28-notifications
rules_hash: e0bb7f8f20c8
---
# Exported service
## Definition
An exported service is the public interface a domain offers to other [domains](domain.md). Notifications uses the exported services of identity and tenancy to turn user ids into [recipients](notification-recipient.md). It never reads those domains' tables directly. Calls are batched once per [consumed batch](consumer-batch.md), with a cap on ids per call. A user who cannot be found produces no notification.

## Example
A consumed batch of order events names 600 distinct users (illustrative). The router makes one call with 500 ids and a second call with 100 ids, instead of one lookup per event. If one id is unknown, that user gets no [inbox item](inbox-item.md) and no [delivery](delivery.md).

The reason for going only through exported services is design intent (not stated in the spec): each domain owns its tables, and other domains depend only on its published interface.

## Known gaps
- The spec does not name the identity and tenancy services that are called, or which recipient fields they return (locale, e-mail, phone).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-07, R-51
- [consumer-batch](consumer-batch.md)
- [delivery](delivery.md)
- [domain](domain.md)
- [inbox-item](inbox-item.md)
- [notification-recipient](notification-recipient.md)
- [recipient-rule](recipient-rule.md)
<!-- used-by:end -->
