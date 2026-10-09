# Contract: event envelope and relay message

Schema source: `packages/contracts` (envelope zod schema, exported name `eventEnvelopeSchema`). Parsed by `events/contracts-parity.spec.ts` (AS-108).

| Field | Type | Rule |
|---|---|---|
| eventId | UUIDv7 string | stable across duplicates |
| type | string | lowercase dotted `a.b_c`; unique with `version` |
| version | int ≥ 1 | payload contract version; additive within a version |
| aggregateType | string | registered with `TopicRegistry` |
| aggregateId | string | message key |
| aggregateVersion | int 0..2^53−1 | aggregate version after the change; strictly increasing per aggregate, also on delete |
| occurredAt | ISO 8601 UTC | injected clock |
| traceparent | string? | W3C trace context |
| payload | object | validated per `(type, version)`; serialized envelope ≤ 256 KiB |

## Relay message (poller and CDC identical, AS-13, AS-21)
- topic `<aggregateType>.events`; key `aggregateId`; value = the envelope JSON itself (no `{payload, extra, error}` wrapper)
- headers: `eventId`, `type`, `version`, `traceparent` (when present)
- Task rows go to the queue instead: body = task body, dedupe id = outbox row id, attributes carry `traceparent`.

## Outbox row contract (framework-free writers, AS-08)
See `data-model.md`. Minimum insert: `id, kind, topic, aggregateId, aggregateType, type, payload, status='pending', attempts=0, nextAttemptAt, createdAt`. The database rejects null `aggregateId`, unknown `kind`/`status` and an event payload without `eventId`.
