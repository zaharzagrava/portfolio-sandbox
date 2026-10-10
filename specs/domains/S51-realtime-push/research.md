# Research: S51 — Realtime push hub

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted as written (no human-edited line found). Decisions below close the design choices the spec leaves to the plan.

## D1. Atomic publish (FR-022)
- **Decision**: one Lua script (`EVAL`, loaded once, `EVALSHA` with fallback) per publish: `XADD rt:s:<topic> MAXLEN ~ 1000 * type data`, `PEXPIRE` the stream to the retention age, `PUBLISH rt:c:<topic> <json with id>`, return the id. A live-only publish is a plain `PUBLISH` (no script).
- **Rationale**: the id comes from `XADD`, so `MULTI` cannot carry it into `PUBLISH`; a script is the only atomic form. Single-key script, so cluster-safe (stream key and channel are not keys of the same slot concern: `PUBLISH` is not slot-checked).
- **Alternatives**: `MULTI` (cannot use XADD id); two commands (today; crash window); Redis Functions (more ops surface, same effect).
- **Age floor**: the script also runs `XTRIM … MINID ~ <now-1h>` using the Redis server clock (`TIME`), so age is not tied to app clocks.

## D2. Keys (I.4, prefix `rt:`)
`rt:s:<topic>` replay stream; `rt:c:<topic>` live channel; `rt:ctl` revocation control channel; `rt:trim:<topic>` not used (see D4). All owned by the lib; the legacy channel names are replaced in one step (no domain reads them; only the hub does).

## D3. Subscribe races (FR-025, FR-026)
Hub keeps `Map<channel, {listeners:Set, ready:Promise<void>}>`. First listener creates the entry with `ready = subscriber.subscribe(channel)`; later listeners await the same promise; on rejection the entry is deleted before the rejection propagates. Release is idempotent through a per-listener `released` flag; last release deletes the entry first, then `UNSUBSCRIBE`s (a concurrent new subscriber creates a fresh entry).
**Alternative**: a mutex per channel (more code, same result).

## D4. Resync decision (FR-017) — pure function
Inputs: cursor, `now`, retention age, and from the store `maxDeletedId` (`XINFO STREAM … max-deleted-entry-id`, Redis ≥ 7.0; `0-0` when nothing was ever trimmed) and whether the stream exists. Rules, in order: cursor time older than `now - retention` → `resync`; stream missing (expired) and cursor not equal to the baseline of an empty topic → `resync`; `maxDeletedId > cursor` → `resync` (an entry after the cursor was trimmed); otherwise replay `(cursor, +)`. No extra key and no write per publish. The function is pure (`topics.spec.ts`); the store reads are in the stream service.
**Alternative**: a trim-watermark key written on each publish; rejected (extra write, same information).
**Alternative**: store a trim watermark key (extra write per publish); rejected.

## D5. Backplane loss and gap-fill (FR-046, AS-66)
The subscriber connection emits `ready` after reconnect. The hub emits an internal `resubscribed` event; every open stream rebuilds its replay phase from its cursor (same code path as connect: buffer live, page `XRANGE`, flush with dedupe). `ioredis` resubscribes channels itself; the hub only triggers gap-fill and counts it.

## D6. Revocation transport (FR-039, FR-040)
Control channel `rt:ctl` with JSON `{userId?, prefix, id, suffix?, at}`; each instance subscribes once (permanent entry, not ref-counted). A connection keeps `topics[]` with state `admitting|active|revoked`; a notice matching a topic in any state marks it revoked; an `admitting` connection checks marks after the rule returns (AS-56). Effect: write `revoked` frame, release that topic's subscription; if none remain, end the response.
**S03 follow-up (user input)**: S51 provides `revoke`; the consumer lives in tenancy (X.3, A-10). Plan item P-REV-1 below adds it as a requirement with its test, because it was left for this capability.

## D7. Revocation consumer in tenancy (follow-up from S03)
- A `Projector` in `libs/domains/tenancy/infra/member-revocation.consumer.ts`, shaped like `ShopPlanConsumer`: `topics=[MemberRemoved.topic]`, `idempotency: 'versionGuard'`-equivalent is not needed because `revoke` is naturally idempotent (revoking twice is harmless); declared `idempotency = 'naturallyIdempotent'` if the `Projector` type permits it, otherwise the nearest allowed value with the reason in a comment (to be confirmed at task time by reading `projector.ts`).
- It calls `RealtimeSubscriptions.revoke({ userId, prefix: 'shop', id: shopId })` (all suffixes: `live`, `assets`). It validates the payload with `MemberRemoved.match` and throws `PermanentError` on a bad payload. Reasons `removed`, `left`, `shop_deleted` all revoke (the user lost the right either way).
- A `revoke` failure (store outage) does not fail the projection permanently: the consumer lets the error retry (transient), since the connection lifetime bounds the worst case anyway.
- The consumer is registered in the tenancy module and loaded in the gateway app (via the topics module) **and** wherever the projector runner lives; the plan resolves this by registering it in the same module that already registers `ShopPlanConsumer`, so the runner picks it up wherever tenancy projectors run. `revoke` only needs the lib's publisher-side connection, so it works from any process; the gateway instances receive the notice through `rt:ctl`.
- Test: e2e in `libs/domains/tenancy` (`member-revocation.e2e-spec.ts`): member with an open `shop:<id>:live` stream; remove member through the real API; assert `revoked` frame within 2 s, no later event, other member unaffected, re-admission rule still decides (AS-54, AS-58 at domain level). Uses the real stream module hosted in the test app. This test belongs to S51's follow-up list, not to S03's suite.

## D8. Policy and credential handling (FR-010, FR-011, FR-012)
Use S01's anonymous-allowed marker and invalid-credential `401` if present; otherwise (S01 not yet there) the controller's own guard step: a presented credential that fails verification → `401`. Rules run via `Promise.allSettled` with `AbortSignal`-less `Promise.race` against a 2 s timer; any rejection/timeout → `503 realtime_policy_unavailable`. Viewer `roles` come from the principal.

## D9. Limits and configuration (FR-050)
One zod-validated `RealtimeConfig` (env-driven, defaults from spec) read through `ApiConfigService`; out-of-range values fail boot. Tests set millisecond values via overrides in the test module.

## D10. Contracts (FR-053)
`packages/contracts/src/realtime.ts`: zod schemas `streamQuerySchema`, `streamEventEnvelopeSchema`, `resyncDataSchema`, `revokedDataSchema`, `cursorSchema`. e2e specs and `packages/web/lib/api/sse.ts` import them.

## D11. Transactions (cross-spec rule 4)
The lib issues no SQL and opens no transaction. `.tx.baseline` must not rise. The new tenancy consumer uses the existing `ShopTransactionRunner` only if it needs DB work; it does none (calls `revoke` only), so no transaction site is added. No `// S54 T037 audit` comment exists in the files this plan touches (grep: 0).

## D12. New deployable app?
No. The gateway app already exists (I.6 not triggered); this plan moves its engine into the lib.
