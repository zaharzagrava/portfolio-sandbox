---
id: domain
title: Domain (writing domain)
kind: term
status: draft
aliases: [domain]
defined_for: S53-events-projections
rules_hash: 90ea34e80275
---
# Domain (writing domain)
## Definition
A domain is one business area of the system, such as the orders domain or the identity domain. It owns its own tables and data. The writing domain is the domain whose code changes state and [appends an event](outbox-append.md) about that change. It does this in the same transaction, through the [outbox service](../capabilities/S53-events-projections.md). Other domains react to the event from the log and never read the writing domain's tables. No domain may touch the [outbox or inbox tables](inbox-table.md) except through this capability's exported services, and a CI check enforces this.

## Example
In S53.B-01, the writing domain updates [aggregate A](aggregate-id.md) from version 3 to 4. In the same transaction it appends `fixtures.item_changed` and commits. Exactly one [pending outbox row](pending-row.md) now exists, and the [relay](outbox-relay.md) publishes it for other domains to consume.

## Known gaps
- The spec does not list the domains or say how the CI check (`pnpm check:table-ownership`) decides which domain owns which table.
- The spec does not say whether the framework-free writers (the Lambda of S29 and the Rust gateway of S24) count as domains under the [table-ownership rule](table-ownership.md).

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): B-12, B-13
- [aggregate-id](aggregate-id.md)
- [api-layer](api-layer.md)
- [application-layer](application-layer.md)
- [billing-invoice-paid-event](billing-invoice-paid-event.md)
- [boundary-finding](boundary-finding.md)
- [boundary-review](boundary-review.md)
- [domain-boundary-rules](domain-boundary-rules.md)
- [exported-service](exported-service.md)
- [fact](fact.md)
- [inbox-table](inbox-table.md)
- [media-controller](media-controller.md)
- [outbox-append](outbox-append.md)
- [outbox-relay](outbox-relay.md)
- [pending-row](pending-row.md)
- [table-ownership](table-ownership.md)
- [unregistered-aggregate-type-error](unregistered-aggregate-type-error.md)
<!-- used-by:end -->
