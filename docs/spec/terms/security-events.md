---
id: security-events
title: Security events
kind: term
status: draft
aliases: [six events]
defined_for: S02-mfa-oidc
rules_hash: d80b20044ff6
---
# Security events
## Definition
Security events are the fixed set of [domain events](realtime-event.md) that S02 publishes when a [second-factor ↗](../sw-external-terms.md#mfa) or identity state changes. Each one carries a standard set of [identifying members](event-envelope.md), and they hold identifiers only, never secrets, codes or e-mails. An event is [committed in the same transaction](outbox-append.md) as the state change it records. So an event exists only if the change happened, and a rejected call leaves no event behind.

## Example
Two concurrent disables use the same code. One answers `204` and the other answers [`409 mfa_not_enabled`](mfa-not-enabled.md), and exactly one event exists:
```json
{ "eventId": "evt_01H…", "type": "identity.mfa_disabled", "version": 1,
  "occurredAt": "2026-10-13T09:00:00Z", "aggregateId": "usr_42" }
```
(the [`eventId`](event-id.md), `version`, timestamp and [`aggregateId`](aggregate-id.md) values are illustrative)

## Known gaps
- The spec excerpt does not name the full set. Only `identity.mfa_disabled`, `identity.mfa_recovery_code_used` and `identity.mfa_recovery_codes_regenerated` appear in the facts, so the other event types are not confirmed.
- The spec does not say which [topic](aggregate-type-events-topic.md) these events go to, or the `version` value of each event type.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-35
- [aggregate-type-events-topic](aggregate-type-events-topic.md)
- [auth-events-total](auth-events-total.md)
- [event-envelope](event-envelope.md)
- [mfa-disabled-event](mfa-disabled-event.md)
- [outbox-append](outbox-append.md)
- [realtime-event](realtime-event.md)
<!-- used-by:end -->
