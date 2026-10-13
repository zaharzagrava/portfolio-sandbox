---
id: subscription-plan-changed-event
title: billing.subscription_plan_changed event
kind: term
status: draft
aliases: [billing.subscription_plan_changed]
defined_for: S03-shops-rbac
rules_hash: 6fc69dd915c4
---
# billing.subscription_plan_changed event
## Definition
`billing.subscription_plan_changed` is an event that the billing capability publishes when a shop's subscription plan changes. Tenancy consumes it to update the shop's plan, which sets its [seat limit](seat.md). Tenancy compares the event's version with what it already applied. If the event is older, tenancy treats it as [stale](consumer-outcomes.md) and leaves the plan unchanged. This keeps [out-of-order delivery](per-aggregate-ordering.md) from rolling a plan back.

## Example
The shop is on `PRO` after a version-5 event. A late version-3 event says `STARTER` (illustrative). Tenancy ignores it and the plan stays `PRO`.

## Known gaps
- The spec does not say what fields the [payload](event-payload.md) has, or which version field is compared (for example [`aggregateVersion`](aggregate-version.md)).
- Not confirmed in the code: whether applying the event emits `tenancy.shop_plan_changed`.
- The spec does not say what happens to existing members or [pending invites](pending-invite.md) when a downgrade puts the shop over its new seat limit.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-18
- [consumer-outcomes](consumer-outcomes.md)
- [event-payload](event-payload.md)
- [pending-invite](pending-invite.md)
- [per-aggregate-ordering](per-aggregate-ordering.md)
- [seat](seat.md)
<!-- used-by:end -->
