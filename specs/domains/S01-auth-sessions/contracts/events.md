# Contract: events and messages emitted by identity

Written through `OutboxService` inside the transaction that changes state (IX.6). Envelope (FR-094): `eventId (UUID), type, version, occurredAt, aggregateId (= userId), payload`; payloads hold identifiers only. Topic key: `userId`. Identity consumes no events (no inbox).

| Type | v | Payload | Written when | Delivery |
|---|---|---|---|---|
| `identity.user_registered` | 1 | `{userId, role}` | new account inserted | fan-out topic |
| `identity.registration_duplicate_attempted` | 1 | `{userId}` (existing id) | each duplicate request | fan-out topic |
| `identity.password_changed` | 1 | `{userId}` | reset confirm commit | fan-out topic |
| ~~`identity.password_reset_requested`~~ | — | not emitted | superseded by the `PASSWORD_RESET_MAILER` port (W01 follow-up): the reset link is handed to the port after commit; the raw token is in no table, outbox row or message |

Contract schemas (zod) are exported from the barrel for the consumer. No e-mail, password data or hash in any payload.
