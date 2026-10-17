# Editing connection contract (consumed by W04)

`wss://<instance>/collab/<draftId>?ticket=<ticket>` — standard y-websocket binary protocol (sync step 1/2, update, awareness) plus one server→client message type for denied writes.

## Handshake order

0. Steps run in this order: 1 (verify signature/claims, no consumption), `Origin`, 2, 3, 4, 5.
1. Parse path and ticket (missing/malformed/expired/wrong key/`alg: none`/wrong `iss`/`aud`/other draft/reused) → HTTP `401`, nothing loaded. `Origin` not allowlisted → `403`.
2. Ownership: if this instance does not own the draft → accept the socket and close `4001` with the owner's address as reason; the ticket is **not** consumed.
3. Re-read the draft (`id` + `shopId` from the ticket); missing → close `4004`.
4. Consume the `jti` (Redis `SET NX EX 60`) only when steps 2–3 passed; an already-consumed `jti` → `401`. The ownership check (step 2) runs before the upgrade is completed so `4001` never burns the ticket; the draft check (step 3) also runs before consumption.
5. Join room (wait for an in-flight unload), buffer early frames in order, server starts sync.

## Permission-denied message

Message type byte `4` (`messagePermissionDenied`), payload: varstring reason (`read_only`). Sent only to the sender of a denied update / sync step 2. The connection stays open.

## Close codes

`1001 room_closed`, `1009` frame/presence too large (frame > 512 KiB, presence > 8 KiB), `1012 service_restart`, `4000 protocol_error`, `4001` wrong instance (reason = owner address; reconnect there with the same ticket), `4002 room_moved` (call connect again), `4003 access_revoked | shop_inactive`, `4004 draft_not_found`, `4005 draft_closed` (call connect; read-only), `4008 room_full | too_many_connections`, `4009 document_too_large`, `4013 store_unavailable`, `4029 rate_limited`.

## Limits

50 connections per room, 5 per user per draft, 512 KiB per frame, 2 MiB encoded document, 200 frames/s per connection, 8 KiB per presence frame, ping 30 s (terminate after one missed answer), presence silence 30 s, idle unload 30 s.

## Internal owner endpoint (instance → instance, not public)

`POST /internal/collab/:draftId/freeze` `{leaseId}` and `…/flush` — authenticated with the ticket key (HMAC of body + timestamp), 3 s client timeout; the owner flushes, marks the room frozen (refuses later updates with close `4005`), and returns `{seq}`. If no room is loaded the caller reads stored state. Used by publish (freeze) and named versions (flush).
