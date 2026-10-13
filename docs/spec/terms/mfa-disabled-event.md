---
id: mfa-disabled-event
title: identity.mfa_disabled event
kind: term
status: draft
aliases: [identity.mfa_disabled]
defined_for: S02-mfa-oidc
rules_hash: 31707d50681d
---
# identity.mfa_disabled event
## Definition
`identity.mfa_disabled` is the event that records a successful removal of a user's [second factor](second-factor-model.md). It is one of [the six events of this capability](security-events.md). It is committed in the [same transaction](active-transaction.md) as the state change, so it exists only if the factor was really removed. A rejected or losing disable call leaves no event, so a race between two disables produces exactly one event. Like the other events, its [envelope](event-envelope.md) carries identifiers only: no secret, code or e-mail.

## Example
```json
{
  "eventId": "9b1c…",
  "type": "identity.mfa_disabled",
  "version": 1,
  "occurredAt": "2026-10-13T09:00:00Z",
  "aggregateId": "user-42"
}
```
(All values are illustrative.)

## Known gaps
- The spec does not say which [topic](realtime-topic.md) the event is published on, or what payload it carries beyond the envelope members.
- The spec does not say that [`aggregateId`](aggregate-id.md) is the user id. That reading is likely, but it is not stated.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-27
- [active-transaction](active-transaction.md)
- [event-envelope](event-envelope.md)
- [realtime-topic](realtime-topic.md)
- [second-factor-model](second-factor-model.md)
- [security-events](security-events.md)
<!-- used-by:end -->
