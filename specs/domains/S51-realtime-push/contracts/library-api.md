# Contract: `@app/infrastructure/realtime` exports

Exact names other specs rely on (spec.md "Provides"). Barrel: `libs/infrastructure/realtime/index.ts`.

- `RealtimePublisher.publish<T>(topic, type, data, options?: { replay?: boolean }): Promise<{ published: boolean; id: string | null }>`. Never throws on store faults; throws the four typed validation errors.
- `TopicRegistry.define({ prefix, suffixes?, singleton?, owner?, policy })`; frozen after start.
- `TopicSubscriber.subscribe(topic, handler): Promise<() => Promise<void>>`; `RealtimeMessage = { id, topic, type, data }`.
- `RealtimeSubscriptions.topicsWithSubscribers(prefix, suffix?): Promise<string[]>` (sorted, ≤ 10,000, rejects `RealtimeUnavailableError`).
- `RealtimeSubscriptions.revoke({ userId?, prefix, id, suffix? }): Promise<void>` — publishes on `rt:ctl`; best effort; not a ban.
- Modules: global `RealtimeModule` (publisher, registry, subscriber, subscriptions); `RealtimeStreamModule` (controller + hub engine) imported by the gateway app.

## Consumer of `revoke` required by this plan (follow-up from S03)
`tenancy.member_removed {shopId, userId, role, reason}` → `revoke({ userId, prefix: 'shop', id: shopId })` (closes `shop:<id>:live` and `shop:<id>:assets`). Implemented in tenancy (`MemberRevocationConsumer`), not in the hub.
