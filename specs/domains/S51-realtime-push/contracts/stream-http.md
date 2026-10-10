# Contract: `GET /api/streams?topics=<t1>,<t2>` (FR-001 to FR-020)

Schemas: `packages/contracts/src/realtime.ts` (`streamQuerySchema`, `streamEventEnvelopeSchema`, `resyncDataSchema`, `revokedDataSchema`, `cursorSchema`).

**Request**: only query parameter `topics` (1–10 distinct, comma-separated). Credential: session cookie or `Authorization: Bearer`. Optional `Last-Event-ID: <topic>~<pos>|…` (≤ 2,048 chars). Any other query parameter → `400`.

**Success**: `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, never compressed.

Frames:
- `retry: <2000..5000>` first.
- baseline: `id: <cursor>` with no event (first connect, FR-006).
- event: `[id: <cursor>\n]event: <type>\ndata: {"topic":"…","data":…}\n\n` (live-only: no `id:`).
- `event: resync` `data: {"topic":"T","data":{"reason":"replay-gap"}}`.
- `event: revoked` `data: {"topic":"T","data":{}}`.
- heartbeat `: ping`.

**Errors** (problem+json with `code`): `400 invalid_topics|unknown_topic|unsupported_query`, `401` (invalid credential anywhere; anonymous refused), `403` (generic, no topic name), `429 too_many_connections` (`Retry-After: 5`) and `429` from `realtime.connect`, `503 realtime_policy_unavailable`, `503 realtime_capacity` (`Retry-After` 1–5), `503 realtime_unavailable`.
