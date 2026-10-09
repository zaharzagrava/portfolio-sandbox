# Contract: exported services and consumer declaration

The signatures are those in `spec.md` "Cross-capability contracts / Provides"; this file records only the plan's decisions on top.

- `OutboxService.append*`, `requeueParked` — `@app/infrastructure/outbox`. `append` and `appendTask` throw `NoActiveTransactionError` outside a transaction.
- `EventPublisher` — `@app/infrastructure/events`; caller supplies a stable `eventId`.
- `TopicRegistry.register` — called at module init by the owning domain; duplicate or unknown aggregate type rejects.
- `InboxService` — `@app/infrastructure/inbox` (new). `claim` outcomes `CLAIMED | DUPLICATE_IN_PROGRESS | DUPLICATE_DONE`.
- `Projector` / `ProjectionsModule.forProjectors(types, imports?)` — start fails on missing `idempotency`, duplicate `name`, or `coalesce` on a `carries: 'delta'` event.
- **`forProjectors` host contract (D-8, FR-040)**: the host app (`apps/projector`) calls `ProjectionsModule.forProjectors([MyProjector, …], [ModulesTheyInject])` once. The framework provides what every consumer needs (runner, checkpoints, dead-letter writer, inbox, transactions, Redis document sink, `TransactionalPipeline`); `imports` adds the stores and domain modules the listed projectors inject (their `SequelizeModule.forFeature`, search client, other domains' exported services). Consumers start in `onApplicationBootstrap`, after every module has initialised, and stop through `ShutdownRegistry` (≤ 20 s). A wrong declaration fails the whole startup before any consumer starts. A projector reaches another domain's data only through that domain's exported service (IX.4); S12 and S32 follow-ups in `gaps.md` remove the two remaining direct reads.
- `TransactionalPipeline.run({transactionalId, groupId, inputTopic, handle})` — `handle(batch, emit)`; outputs and input offsets commit in one Kafka transaction; an older instance with the same `transactionalId` is fenced (`handle.fenced`) and stops.
- Sinks return `{applied, duplicate, stale}`; `applyIfNewer(stored, incoming)` is pure.
- `ReadYourWrites.resolve`, `ProjectionCheckpoints.record`, `ConsumerLag.read`, `TransactionalPipeline.run`.
- `TaskQueue`: `dedupeId`, `enqueueBatch → {sent, failed}`, `consume(…, {bodySchema})`.
- Jobs registered with S49: `outbox.purge-published` (7 d), `inbox.purge` (30 d). The poller is not a job.
- Config keys (validated at startup, FR-064): relay mode/interval/batch/lease/attempts/retention, consumer batch/attempts/backoff/handler timeout/in-flight/graceful stop, read-your-writes budget, checkpoint TTL, promotion gate, default partitions.
