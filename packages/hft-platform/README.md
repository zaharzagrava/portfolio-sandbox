# chat-gateway (packages/hft-platform)

WebSocket gateway for the marketplace's per-product chat. Handles connection
management, realtime message/typing fan-out, and moderation enforcement.
Channel/message CRUD and history reads live in NestJS
(`packages/backend/libs/common/src/chat`); this service owns only the
connect-once-subscribe-to-many-channels realtime path, and writes chat
messages directly to Postgres for latency reasons.

See `src/protocol.rs` for the wire format and
`packages/backend/libs/common/src/chat/chat.constants.ts` for the Redis
pub/sub topics both runtimes share.

## Running locally

This crate reads its config from environment variables - the same
`DB_*`/`REDIS_URL`/`JWT_SECRET` values `packages/backend/.env` already
defines (both runtimes must point at the same Postgres, Redis and JWT
secret). Since `cargo run` here runs with this directory as its working
directory, it won't pick up `packages/backend/.env` automatically. Either:

- Create `packages/hft-platform/.env` (already covered by the repo's
  `.env*` gitignore rule) with the same `DB_HOST`/`DB_PORT`/`DB_USERNAME`/
  `DB_PASSWORD`/`DB_NAME`/`REDIS_URL`/`JWT_SECRET` values as
  `packages/backend/.env`, plus optionally `CHAT_GATEWAY_PORT` (defaults to
  `8090`, matching `CHAT_WS_URL` in `packages/backend/.env`); or
- Export those same variables in your shell before `cargo run`.

```
cargo run       # or: moon run hft-platform:dev
```

`GET /healthz` returns `200 ok` once it's up. The browser connects to
`GET /ws?ticket=<short-lived JWT from POST /api/chat/ws-ticket>`.
