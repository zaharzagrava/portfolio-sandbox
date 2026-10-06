<!--
Sync Impact Report
- Version change: 3.0.0 → 3.1.0 (MINOR: new top-level area added through the X.6 amendment path;
  no rule removed. The Communication Matrix BFF row is narrowed only to match IX.7 R2, which was
  already binding.)
- Modified principles:
  * X. Monorepo Structure & Module Boundaries: "four" → "five" top-level areas. New rule X.8
    defines `libs/composition/<client>`. X.1, X.5 (dependency table), X.6 (allowed folders), and
    X.7 (placement test) are updated to include it. Existing rule IDs X.1–X.7 are unchanged.
  * IX. IX.7 R2 now names `libs/composition/<client>` (deployed by `apps/bff`) as the R2
    implementer.
- Communication Matrix: the "BFF / public-api / edge-be" row is split. A new
  `libs/composition/<client>` row is added (HTTP clients only), and the old row keeps
  public-api / edge-be.
- PR gate 11 now covers composition rules.
- Removed sections: none
- Follow-up TODOs (code, not governance):
  * Move libs/common/src/bff → libs/composition/bff and the widget orchestration →
    libs/composition/widget. Split bff/batch-read.controller into the owning domains' api/.
  * Update docs/architecture/domain-map.md §1.1 / §2 / §5 D1 (bff is no longer a domain).
  * Add @app/composition/* alias and X.8 rules to the X.6 dependency check.
- Templates requiring updates: none modified.
-->

# Marketplace Sandbox Constitution

Scope: every TypeScript package in this repository (`packages/backend`, `packages/web`,
`packages/edge-be`, `packages/contracts`). `packages/hft-platform` (Rust) and `packages/payments`
(Go) are out of scope. Rule IDs (e.g. `III.3`) are cited in reviews; every rule is a MUST unless
it says otherwise.

## Core Principles

### I. Layered Domain Modules

1. Every backend domain module is one directory containing `<domain>.module.ts` and only these
   layer folders:
   - `api/`: controllers, request/response DTOs, route decorators.
   - `application/`: use-case services. The only layer that orchestrates, opens transactions,
     and publishes to the outbox.
   - `domain/`: entities, value objects, state machines, pure domain services, port interfaces
     and their injection tokens.
   - `infra/`: repositories, ORM models, external clients (adapters), message producers and
     consumers.
2. Allowed import directions are `api → application → domain` and `infra → domain`.
   `application` reaches `infra` only through `domain` port tokens (`@Inject(TOKEN)`), never by
   importing an `infra/` class. Check: no `infra/` path appears in imports of `api/` or
   `application/` files, and no `api/` or `application/` path appears in `domain/` files.
3. `domain/` files import nothing from `@nestjs/*`, `sequelize*`, `ioredis`, `kafkajs`,
   `@aws-sdk/*`, `express`, or any database or HTTP client. They read the current time only
   through an injected `now` / clock parameter, never `new Date()` or `Date.now()`.
4. Each ORM model, table, Redis key prefix, DynamoDB table, Kafka topic (as producer), and
   search index has exactly one owning module, declared in that module's `infra/`.
5. `apps/<name>/` contains only bootstrap (`main.ts`, instrumentation) and the composition
   module that imports domain modules. No controllers, services, or queries live in `apps/`.
6. A new deployable app needs a written reason in `plan.md` (different scaling or latency
   profile, isolation, or release cadence). Otherwise it is a module in an existing app.

### II. Request Pipeline & Routing Placement

1. HTTP routes are declared only in `api/` controllers (or Next.js `app/` route handlers and
   pages for web). A controller method does three things: receive validated DTOs, make one call
   to an application service, and return a response DTO. It contains no queries, no transaction
   handling, no `try/catch` that builds HTTP responses, and no branching on domain state.
2. Each concern sits at one fixed pipeline stage:
   - Middleware: only concerns that don't need to know the handler (request ID, raw body for
     signature checks, helmet, CORS, cookie parsing).
   - Guards: authentication and coarse role checks (RBAC through `Reflector` metadata).
   - Pipes: input validation and transformation (global `ValidationPipe` with `whitelist` and
     `forbidNonWhitelisted`).
   - Interceptors: timing and metrics, response mapping, caching, timeouts, idempotency.
   - Exception filters: the only place that turns errors into HTTP responses.
3. Record-level authorization (whether this principal can access record X) never lives in a
   guard. It lives in the query (see III.4).
4. Request context (principal, tenant, request ID, active transaction) travels through
   AsyncLocalStorage (`nestjs-cls`). `Scope.REQUEST` providers are forbidden.

### III. Data Access & Transaction Discipline

1. Only `infra/` repositories of the owning module (I.4) read or write its store. No other
   module, controller, or app issues queries against it.
2. Transaction boundaries are opened only in `application/` (`@Transactional()` via CLS, or an
   explicit transaction object). Every query inside a transaction runs on that transaction's
   connection.
3. No network I/O inside an open DB transaction: no HTTP calls, S3, email, Kafka/SQS publishes,
   or LLM calls. Side effects leave through a transactional outbox row written in the same
   transaction, or run after commit.
4. Every lookup of a tenant-owned or user-owned record puts the principal in the predicate
   (`WHERE id = $1 AND tenant_id = $2`). Loading by primary key and checking ownership afterwards
   is forbidden. List endpoints apply the same scope, including to every joined or `include`d
   association.
5. SQL is parameterized. Dynamic identifiers (sort column, direction) come from a hard-coded
   allowlist. `sequelize.literal`, `query`, and raw fragments never interpolate request data.
6. Invariants that must never break (non-negative balance, no double booking, no double spend,
   uniqueness) are enforced inside one strongly consistent store, by a constraint, a conditional
   update, or a row lock. They are never enforced by an application-level check-then-write.
7. State transitions are conditional updates (`UPDATE … WHERE id = :id AND status = :from`) that
   assert one affected row, plus a history row in the same transaction. Status types are
   discriminated unions, and every `switch` over them ends in `assertNever`.
8. Money is integer minor units (`BIGINT` / `bigint`). Floating-point money is forbidden.
   Ledger entries are append-only, and each transaction's entries sum to zero.
9. Caches are never the source of truth. Reads use cache-aside, writes delete the key, and every
   key has a TTL. `KEYS` is forbidden (use `SCAN`). Queue data and cache data never share a Redis
   instance that runs an `allkeys-*` eviction policy.
10. List endpoints use cursor (keyset) pagination with an opaque cursor and a deterministic order
    that ends in a unique tiebreaker (`ORDER BY created_at DESC, id DESC`). Offset pagination is
    forbidden on tables that grow without bound.
11. Migrations follow expand/contract: no single-step rename, type change, or drop of a column
    that running code still reads. Every migration sets a `lock_timeout`. Migrations run as a
    separate deploy step, never during app startup.
12. Every DB connection or role has a `statement_timeout`. Pool size × max instances stays
    below the database connection limit, and the arithmetic is written in `plan.md`.

### IV. Module & Service Communication

1. In-process, module A may use module B only in two ways: by injecting a provider that B
   explicitly `exports` from its application layer (or a port token B exports), or by consuming
   a domain event that B publishes. Importing B's `infra/`, `domain/` internals, models, or
   repositories is forbidden.
2. Circular module dependencies (`forwardRef`) are forbidden. Break the cycle with a third module
   or an event.
3. Across processes, modules communicate asynchronously through messaging only, never through a
   shared table:
   - Domain events that need fan-out or replay go to Kafka, keyed by aggregate ID.
   - Single-consumer tasks go to SQS (FIFO with `MessageGroupId` when per-entity order matters).
   - Scheduled work uses a job table claimed with `FOR UPDATE SKIP LOCKED`.
   - Redis pub/sub is only a realtime fan-out backplane and never carries anything that must be
     delivered.
4. Events that originate from a DB change are published only through the outbox or CDC, never
   with a direct dual write. Every event has `eventId`, `type`, `version`, `occurredAt`, and the
   aggregate ID.
5. Every consumer is idempotent: an inbox table, a unique key on `eventId`, or a version-guarded
   upsert. Its module documents which mechanism it uses. Every consumer validates its payload with
   zod before acting. Poison messages go to a DLQ and never block the queue.
6. Every outbound network call (HTTP, DB, Redis, queue, LLM) sets an explicit timeout. Retries
   happen only on transient failures (timeout, reset, 429, 502/503/504, serialization or deadlock
   errors), only for idempotent operations, with exponential backoff plus full jitter and at most
   3 attempts in synchronous paths. Retries happen at exactly one layer.
7. Services never trust identity headers (`X-User-Id`, `X-Tenant-Id`) unless a gateway that
   strips client-supplied copies set them. A user's access token is never forwarded to a service
   outside its `aud`.
8. External systems are reached only through a `domain/` port plus an `infra/` adapter. Their
   responses are validated before use (anti-corruption layer).

### V. API Contracts & Error Semantics

1. ORM models are never serialized directly. Every response goes through an explicit response
   DTO, and secrets (`passwordHash`, tokens, internal IDs not meant for clients) are never in it.
2. Every public or client-facing endpoint has a zod schema for its request and response in
   `packages/contracts`. Clients import types from there and never hand-write duplicate types.
3. Every error response is RFC 9457 `application/problem+json`, produced by the single global
   exception filter. It carries `type`, `title`, `status`, `detail`, `instance`, and `requestId`.
   For any 5xx, `detail` is a generic message, and stack traces, SQL, and upstream messages never
   reach the client.
4. Status codes: `401` means unauthenticated, `403` means authenticated but forbidden, and `404`
   is returned instead of `403` when the resource's existence must stay hidden (cross-tenant).
   `409` covers state conflicts and `422` covers semantic validation and idempotency-key misuse.
   Account-enumeration flows (password reset, signup) give the same response whether or not the
   account exists.
5. `GET` and `HEAD` never change state. Non-CRUD actions are sub-resources
   (`POST /orders/:id/cancel`).
6. Every `POST` that creates an order, payment, booking, bid, or ledger movement requires an
   `Idempotency-Key`:
   - A replay of a completed request returns the stored status and body.
   - A request with a key that is still in flight returns `409`.
   - Reusing a key with a different body returns `422`.
   - Keys have a TTL.
7. Within a version, changes are additive only. Removing or changing a field or endpoint follows
   expand/contract and is announced with `Deprecation` and `Sunset` headers before removal.
8. Outbound webhooks are HMAC-signed over `timestamp.rawBody`. Inbound webhooks:
   - Verify the signature over the raw body and reject timestamps older than 5 minutes.
   - Return 2xx after enqueueing, not after processing.
   - Deduplicate on the provider's event ID.

### VI. Frontend Boundaries & State Management

1. Components are Server Components by default. `'use client'` appears only on a component that
   uses state, effects, event handlers, or browser APIs. Client components never import
   server-only modules (DB clients, secrets).
2. The browser talks only to same-origin endpoints (Next.js route handlers, server actions, or
   the BFF). OAuth access and refresh tokens never reach browser JavaScript: no `localStorage`, no
   `sessionStorage`, no non-HttpOnly cookies. The session is an HttpOnly, `Secure` cookie with an
   explicit `SameSite`. Every cookie-authenticated state-changing request is CSRF-protected,
   login and logout included.
3. Network calls live only in `lib/api/*` (typed functions that use `packages/contracts`
   schemas) or in server-only data modules. Components and hooks never call `fetch`, `axios`, or
   `EventSource` directly.
4. Each kind of state has exactly one home:
   - Server data: TanStack Query, with keys taken only from `lib/query-keys.ts`. It is never
     copied into `useState`, Context, or a global store.
   - Shareable view state (filters, sort, pagination cursor, selected tab): URL search params.
   - Local UI state: `useState` or `useReducer` in the lowest component that needs it.
   - Context: only rarely-changing globals (theme, locale, session user, feature flags). A
     Context that carries a reducer is split into a state context and a dispatch context.
   - A global client store (Zustand or RTK): only with a written justification in `plan.md`
     (many writers, high-frequency updates, or access outside React).
5. Authorization is never enforced only in Next.js middleware or proxy. It is enforced again in
   the route handler, server action, or backend that touches the data.
6. Lists render with stable IDs as `key`. Array indexes are forbidden as keys for lists that can
   reorder, insert, or delete.
7. User content is rendered as text. `dangerouslySetInnerHTML` is used only on output of an
   allowlist sanitizer (DOMPurify). `eval`, `new Function`, and string `setTimeout` are forbidden.
8. Props passed to client components contain only the fields that component renders. Whole
   translation dictionaries or CMS documents are never passed.
9. Business rules live in backend domain services. The web app and BFFs only compose, shape, and
   present data (no "god BFF").

### VII. Testing Mandate (NON-NEGOTIABLE)

1. **Static layer**: `tsc --noEmit` in strict mode and ESLint pass for every touched package.
   The I.2 / I.3 / IV.1 boundary rules are enforced by lint (import restrictions) once tooling
   exists. Until then, reviewers check them by hand.
2. **API e2e (the deep layer)**: every new or changed HTTP endpoint has a `*.e2e-spec.ts` that:
   - Boots a Nest app from the real feature modules with the production global pipe, filter,
     prefix, and interceptors, and calls it through `supertest`.
   - Runs against real engines of the production major version (Postgres, Redis, Kafka/SQS
     stand-ins, etc., from `docker-compose.test.yaml`) with real migrations applied. Mocking or
     stubbing the project's own repositories, ORM, or stores is forbidden.
   - Replaces only system-edge dependencies (identity provider token verification, third-party
     HTTP, email, LLM) with fakes or spies, and freezes time.
   - Resets state before each test (`clean()` / truncate) and seeds through the shared fixture
     helpers.
   - Asserts the response body **and** the resulting persisted state (DB rows, cache, outbox
     rows, or emitted messages) in every test.
3. **Mandatory API cases per endpoint**: happy path; every distinct validation-failure class;
   `401` without credentials; a cross-tenant / other-user access attempt that returns `404` or
   `403` (IDOR); and, when the endpoint has one:
   - Idempotency: replay, in-flight, and different-body cases.
   - Rate limit: the `429` response.
   - State-transition guard: an illegal transition returns `409`.
   - Invariant protection (III.6): two concurrent requests (`Promise.all`), asserting that exactly
     one succeeds and the invariant holds.
4. **Async consumers**: each consumer has a test that delivers the same message twice and
   asserts a single effect. It also has a test that sends an invalid payload and asserts that the
   payload is rejected or dead-lettered without side effects.
5. **Unit layer**: only for pure `domain/` logic and complex isolated logic (money math,
   allocation, parsing, merge rules, signatures, state machines). These tests are table-driven
   (`describe.each` / `it.each`). Invariants over money and allocation also get property-based
   tests (`fast-check`). Controllers, repositories, and glue code get no unit tests.
6. **Contract layer**: e2e specs parse responses with the matching `packages/contracts` schema,
   so a shape drift fails the test.
7. **UI e2e (Playwright)**: happy-path critical journeys only, once per client that has the
   flow. They never re-test an edge case already covered at the API layer. No fixed sleeps (only
   auto-waiting, web-first assertions) and an isolated user per test. **FE unit and component
   tests** (Vitest plus React Testing Library queried by role, MSW at the network boundary) cover
   UI-only validation and complex client logic.
8. **Traceability**: every acceptance scenario in `spec.md` maps to exactly one row in the
   feature's Test plan table (`Scenario | API e2e | UI journey | Unit`). Each edge case appears
   once, at the lowest layer that can prove it. Each spec file's top-level `describe` names its
   feature.
9. **Gates**:
   - A bug fix includes a test that fails without the fix.
   - A fallback or degradation path (circuit breaker, cache miss path, shed load) has a test that
     forces it.
   - A PR merges only after a recorded green run of the affected suites. "Written but not run"
     never satisfies this gate.

### VIII. Operational Safety

1. Logs are structured JSON (pino) and every line carries `requestId` / `traceId`. Logs never
   contain secrets, tokens, passwords, full card or bank numbers, or raw request bodies holding
   PII.
2. OpenTelemetry instrumentation loads before any application import (`instrument.ts` is the
   first import in `main.ts`).
3. Liveness checks only in-process health (event loop responsive, no external dependency).
   Readiness reflects startup completion and shutdown, and does not fail every instance at once
   when a shared database is down.
4. Shutdown is graceful (`enableShutdownHooks`), in this order: stop accepting traffic and fail
   readiness, drain in-flight requests, stop consumers, then close pools.
   `process.on('uncaughtException')` logs and exits; it never keeps running.
5. Configuration is schema-validated at startup, and startup fails on missing or invalid
   values. Secrets come from the secret store or environment and never from the repo or the
   image.
6. Every scheduled job runs once per schedule across replicas (transaction-scoped advisory lock
   `pg_try_advisory_xact_lock`, a dedicated scheduler, or job-table claiming) and is idempotent.
7. Passwords are hashed with Argon2id (or bcrypt with cost ≥ 12). JWT validation pins `alg` and
   checks `exp`, `iss`, and `aud`.

### IX. Logical Database Isolation on the Shared `public` Schema

All domains share one physical PostgreSQL database, and every table lives in its single `public`
schema. Per-domain Postgres schemas (`orders.*`) are explicitly rejected, because they force data
migrations that buy nothing logical isolation can't. Isolation is enforced by an ownership
registry plus CI. It is not enforced by Postgres schemas, roles, or grants.

1. **Unit of ownership.** A table is owned by a domain module (`libs/domains/<domain>`, X.2),
   never by a deployment unit in `apps/`. A domain loaded by several processes (e.g. `orders` in
   `core` and `worker`) is still one owner.
2. **Flat table names.** Table names are flat and generic (`invoices`, `users`), with no
   mandatory domain prefix. A name says nothing about ownership; only the registry does.
   Existing tables keep their current names, and renaming is not required by this principle.
3. **Ownership registry.** `packages/backend/db/ownership.ts` is a static map from every table,
   view, sequence, function, and trigger in `public` to exactly one owner. Call this mapping
   `owner(t)`, and call the set of objects a module M owns `owned(M)`. Owners are of two kinds:
   - `domain:<name>`, for every business table.
   - `infrastructure:<lib>`, only for this closed allowlist of technical tables:
     - outbox, owned by the outbox lib;
     - inbox / processed-events;
     - idempotency keys;
     - job queue / schedule;
     - the migration meta table (`SequelizeMeta`).

     Adding a table to the allowlist requires a constitution amendment.

   CI fails if an object exists in a migration but not in the registry, appears under two
   owners, or is a business table owned by an infrastructure lib. The registry entry is added in
   the same PR that creates the table.
4. **The coupling ban.** Write `tables(q)` for the set of objects that a query `q` reads or
   writes: every table in `FROM`, `JOIN`, subqueries, CTEs, `LATERAL`, `UNION`, Sequelize
   `include` / associations, and views. For every query issued by code in domain D:

   `tables(q) ⊆ owned(D)`

   Each of these is banned (cross-domain edges in the query graph = **0**):
   - Any `JOIN`, subquery, CTE, `LATERAL`, `UNION`, or `include` spanning two owners.
   - Any direct `SELECT`, `INSERT`, `UPDATE`, or `DELETE` by domain A on a table owned by
     domain B, even a single-table query.
   - Foreign keys, views, triggers, or functions referencing another owner's table. A
     cross-domain reference is a plain ID column (UUID, branded type in code) with no FK.
   - Sequelize associations between models of different owners.
   - Injecting (`@InjectModel`, `forFeature`) a model of a table the domain doesn't own, or using
     the raw `Sequelize` instance against such a table.
   - One DB transaction writing tables of two domains. The only exception is IX.6.
5. **CI enforcement.** There is no database-level backstop, so a static check is the sole and
   merge-blocking enforcement of IX.3 and IX.4. It runs as a required status check on every PR.
   For each domain D, it resolves every model `tableName`, every `forFeature` / `@InjectModel`
   registration, every association, and every raw SQL string (`sequelize.query`, `literal`), and
   it fails when any referenced table is not in `owned(D)`. SQL with dynamically built table
   names is forbidden, because the check can't resolve it.
6. **Technical-table exception.** Domains reach allowlisted technical tables (IX.3) only through
   the owning infrastructure lib's exported service (e.g. `outbox.append(event)`), inside the
   domain's own transaction (III.3). That call is the only allowed case of one transaction
   touching two owners. The outbox relay or CDC connector reads only the outbox table. Test seed
   and clean helpers may touch every table, and they exist only in test code.
7. **Approved cross-domain read paths.** When domain A needs domain B's data, exactly one of
   these applies. Anything else is forbidden.

   | Situation | Required mechanism |
   |---|---|
   | R1. A needs B's data synchronously, and B's module is loaded in the same deployment process | Call a method that B's module explicitly `exports` (DI), imported from B's public entry point (X.4). It returns a DTO, never a model. Batch methods (`getByIds`) are used; per-row calls (N+1) are forbidden. |
   | R2. A client screen combines data from several domains | A `libs/composition/<client>` lib (X.8), deployed by `apps/bff`, calls each owning domain's HTTP API **in parallel** (`Promise.all` / `allSettled`) with per-call timeouts (IV.6) and partial responses for optional parts (VI.9). The BFF holds no DB credentials and no business rules. |
   | R3. A needs to filter, sort, search, or page over data combining A and B, or needs B's data without a synchronous call | A **read model**: B emits a domain event through the outbox (IX.6) → Kafka topic keyed by aggregate ID → a projector deployed in `apps/projector` upserts the fields into Elasticsearch (search and list views), ClickHouse (analytics), or a table owned by A. Projectors are idempotent with a version guard and are replayable (IV.5). A states the maximum staleness it accepts in `plan.md`. |

   Domain-to-domain synchronous HTTP reads that bypass R1 or R2 are forbidden. Writes and
   reactions across domains follow IV.3–IV.5 unchanged:
   - SQS command for "make B do something";
   - Kafka subscription for "react to B";
   - a saga for an invariant spanning A and B. If that invariant truly needs one ACID
     transaction, the boundary is wrong, so merge the domains in an amendment PR.

   A domain never writes another domain's table.
8. **Event data is copied, not referenced.** Read models store copies of the fields they need,
   keyed by B's ID, plus B's `version`. Nobody writes those copies back to B. If a copy is lost, it
   is rebuilt by replaying the topic.
9. **Extractability test.** For any domain D, moving `owned(D)` to a separate database requires
   zero changes to SQL, models, or queries, and changes only connection configuration. A PR that
   makes this false for any domain violates IX.4.

### X. Monorepo Structure & Module Boundaries

The backend (`packages/backend`) has exactly five top-level code areas. Each one has a fixed role
and a fixed set of allowed dependencies.

1. **`apps/<name>/` are deployment units, not domains.** Examples are `core`, `worker`, `bff`,
   `projector`, `payment-processor`, and `sse-gateway`. An app contains only bootstrap
   (`main.ts`, `instrument.ts`) and one Nest root module that imports domain, composition, and
   infrastructure modules (I.5). Apps contain no controllers, services, models, DTOs, queries,
   or projector logic. Nothing imports from `apps/`.
2. **`libs/domains/<domain>/` are the logical boundaries.** Examples are `chat`, `users`,
   `payment`, and `orders`. Each domain:
   - follows the I.1 layout (`api/`, `application/`, `domain/`, `infra/`);
   - owns its business logic, its DTOs, its Sequelize models, and the tables listed under it in
     the registry (IX.3);
   - keeps its projectors and consumers in its own `infra/`, deployed through `apps/projector` or
     `apps/worker`.
3. **`libs/infrastructure/<lib>/` and `libs/common/<lib>/` are domain-agnostic tools.**
   - `infrastructure` holds clients and adapters: `kafka`, `redis`, `database`, `sqs`,
     `elasticsearch`, `outbox`.
   - `common` holds pure helpers and cross-cutting plumbing: `utils`, `logging`, `telemetry`,
     `config`, `exceptions-filter`.
   - Neither owns business data. They hold no business models and no business tables (only the
     IX.3 technical allowlist), and no domain types, DTOs, or domain names in their APIs. They
     are generic over payload types, e.g. `KafkaProducer<T>` and not `OrderEventsProducer`.
4. **Public entry point.** Each domain exposes exactly one entry file,
   `libs/domains/<domain>/index.ts`, which exports the Nest module, its exported application
   services, their DTO types, and its event contracts. Imports from outside the domain use only
   that entry point (`@app/domains/<domain>`). Deep imports such as
   `@app/domains/<domain>/infra/...` from outside the domain are forbidden.
5. **Allowed dependency directions.** Everything not listed is forbidden:

   | From | May import |
   |---|---|
   | `apps/*` | `@app/domains/<d>` entry points, `@app/composition/<c>` entry points, `@app/infrastructure/*`, `@app/common/*` |
   | `libs/composition/<c>` | its own files, `packages/contracts`, the X.8.4 infrastructure allowlist, `@app/common/*` |
   | `libs/domains/<d>` | its own files, other domains' entry points (only for IX.7 R1 and event contracts), `@app/infrastructure/*`, `@app/common/*` |
   | `libs/infrastructure/*` | other `@app/infrastructure/*`, `@app/common/*`, third-party SDKs |
   | `libs/common/*` | other `@app/common/*`, third-party packages |

   Consequences:
   - `infrastructure` and `common` never import `domains`, `composition`, or `apps`.
   - `domains` never import `composition`, and `composition` never imports `domains`.
   - `common` never imports `infrastructure`.
   - The domain-to-domain import graph is acyclic (IV.2).
6. **CI enforcement.** A dependency-graph check (dependency-cruiser or ESLint
   `import/no-restricted-paths` with boundary rules) encodes X.4 and X.5 and is a required,
   merge-blocking status check. A new top-level folder under `packages/backend` (beyond `apps/`,
   `libs/domains/`, `libs/composition/`, `libs/infrastructure/`, `libs/common/`, plus migrations,
   tests, scripts, and config) requires a constitution amendment.
7. **Placement test.** A file belongs in `libs/domains/<d>` if removing domain `d` from the
   product would make the file dead code. Otherwise it belongs in `infrastructure` (talks to an
   external system) or `common` (pure or cross-cutting). A tool that is used by exactly one
   domain and mentions that domain's concepts belongs to that domain. Code that only exists to
   assemble or shape several domains' API responses for one client belongs in
   `libs/composition/<client>`.
8. **`libs/composition/<client>/` is the client-composition layer (IX.7 R2).** Examples are
   `bff` (web and mobile, GraphQL) and `widget` (embeddable storefront orchestration). One folder
   per client type. Each composition lib is deployed by an app (e.g. `apps/bff`), and it:
   1. **Owns no data.** It has no Sequelize models, no tables (zero ownership-registry entries,
      IX.3), no migrations, and no DB credentials. It writes to no store except a cache of shaped
      responses and the client session store (VI.2).
   2. **Talks to domains only over their HTTP APIs.** It uses typed clients built on
      `packages/contracts` schemas and validates every response with them. In-process imports of
      `@app/domains/*`, including entry points, are forbidden.
   3. **Does only these operations:**
      - parallel fan-out (`Promise.all` / `allSettled`) with per-call timeouts and an overall
        budget (IV.6);
      - batching and de-duplication (DataLoader);
      - field selection, renaming, and nesting of response data;
      - merging responses by ID;
      - pass-through of cursors and pagination;
      - partial-error envelopes for optional sections;
      - caching of shaped responses;
      - session and token handling, plus propagation of the auth context.

      Anything else is business logic and is forbidden there, including:
      - computing prices, discounts, totals, taxes, or stock availability;
      - authorization decisions beyond "is there a valid session" (domains decide);
      - branching on domain state values (statuses) beyond present/absent;
      - fanning one client mutation out to several domains (a mutation is forwarded unchanged to
        exactly one owning domain endpoint, and multi-domain workflows are sagas inside domains,
        IV.4).
   4. **Infrastructure allowlist.** It may import only `@app/infrastructure/http-client`, `net`,
      `cache`, `redis` (session and response cache), and `rate-limit`. Importing `database`,
      `context`, `outbox`, `jobs`, `projections`, `events`, `kafka`, `sqs`, or any data-store
      client is forbidden.
   5. **Is tested at its own boundary.** Its specs stub the domain HTTP APIs at the network
      boundary with contract-valid fixtures. They assert:
      - parallel calls (the total time stays under the sum of the per-call delays);
      - per-call timeout → partial response;
      - one section's failure leaves the other sections intact.

      Domain behavior is never re-tested there (VII.7 pyramid).

## Communication Matrix

Allowed edges are listed. Every edge that isn't listed is forbidden.

| From | May call / import | Must never call / import |
|---|---|---|
| Browser (client components) | same-origin route handlers, server actions, BFF via `lib/api/*` | domain services directly, tokens, DB, other origins' private APIs |
| Next.js server (RSC, route handlers, actions) | BFF / backend public HTTP API, `packages/contracts` | backend DB or Redis directly, backend `libs/` source |
| `libs/composition/<client>` (BFF, widget) | domain HTTP APIs via contract-typed clients, the X.8.4 infrastructure allowlist, `libs/common/*` | `libs/domains/*` (any import), models, tables, DB/Kafka/SQS/outbox, business rules |
| public-api / edge-be | backend domain modules' exported application services (in-process) or HTTP APIs | repositories, models, stores of any domain |
| `api/` controller | own module's `application/` services, DTOs | `infra/`, models, other modules' anything except exported services |
| `application/` service | own `domain/`, own ports (→ `infra/` via DI), other modules' **exported** services, outbox | other modules' repositories, models, tables, keys |
| `domain/` | own `domain/` and shared pure utilities only | Nest, ORM, clients, `application/`, `api/`, `infra/` |
| `infra/` | own `domain/` (implements ports), drivers/SDKs | `application/`, `api/`, other modules' `infra/` |
| Module A ↔ Module B (other process) | Kafka events, SQS tasks, job table, public HTTP API | shared tables, reading B's store, Redis pub/sub for must-deliver data |
| Consumer / worker | own module's `application/` services | controllers; skipping the idempotency check |
| `apps/<name>` | module composition, bootstrap | business logic, queries |
| `libs/infrastructure/*` | other infrastructure libs, `libs/common/*`, SDKs | `libs/domains/*`, `apps/*`, business tables |
| `libs/common/*` | other `libs/common/*` | `libs/domains/*`, `libs/infrastructure/*`, `apps/*` |
| Projector (`apps/projector`, handlers in the consuming domain's `infra/`) | Kafka domain events, Elasticsearch / ClickHouse / tables the consuming domain owns | the source domain's tables, synchronous calls back into the source domain |
| Analytics / reporting (ClickHouse) | data arriving via CDC/outbox → Kafka (IX.7 R3) | the primary Postgres across modules' tables |

## Pull Request Compliance Gates

A PR is mergeable only when the reviewer can answer **yes** to every applicable line. A failed
line blocks the merge unless the Complexity Tracking table in `plan.md` records a justified
exception.

1. Boundaries: new files sit in the correct layer (I.1). Imports follow I.2, I.3, and the
   Communication Matrix. No `forwardRef` and no `Scope.REQUEST`.
2. Controllers satisfy II.1. No HTTP-shaped `try/catch` exists outside the global filter.
3. Data access: principal-scoped queries (III.4), no network I/O inside transactions (III.3),
   invariants enforced by the store (III.6), integer money (III.8), and keyset pagination
   (III.10).
4. Migrations are expand/contract with a `lock_timeout` (III.11).
5. Messaging: outbox/CDC for DB-originated events, idempotent and zod-validated consumers (IV.4,
   IV.5), and a timeout on every outbound call (IV.6).
6. Contracts: response DTOs, a `packages/contracts` schema, problem+json errors, and
   `Idempotency-Key` where V.6 applies.
7. Web: Server Components by default, tokens out of browser JavaScript, calls only through
   `lib/api/*`, and state in its single home (VI.4).
8. Tests: the VII.2/VII.3 cases exist for every touched endpoint, the VII.4 tests for every
   touched consumer, and the Test plan table is updated (VII.8). The green run is recorded
   (VII.9).
9. Operational: no secrets or PII in logs, the probe semantics of VIII.3 are kept, and new jobs
   are single-run and idempotent.
10. Database isolation:
    - Every new table is in the ownership registry under exactly one owner, and business tables
      are owned only by domains (IX.3).
    - Every query satisfies `tables(q) ⊆ owned(D)`: no cross-domain JOIN, subquery, direct
      read/write, FK, association, or transaction (IX.4).
    - Cross-domain reads use only R1, R2, or R3 (IX.7), and the IX.5 check is green.
11. Monorepo boundaries: new code sits in the right area per the X.7 placement test, imports go
    only through domain entry points (X.4) and the X.5 directions, and the X.6 check is green.
    Composition code holds no data and no business logic, and uses only the X.8 operations and
    allowlist.

## Governance

- This constitution overrides all other guidance in the repository: READMEs, `docs/showcase`
  conventions, `CLAUDE.md`/`AGENTS.md`, and existing code. When existing code violates it, the
  code is debt to fix. It is not precedent to copy: new code follows the constitution even when
  its neighbours don't.
- The upstream source of truth is `interview-prep`. An amendment that
  contradicts those notes must cite the note section it departs from and give the reason.
- Amendments are made only through `/speckit-constitution` in a dedicated PR. The PR includes
  the Sync Impact Report and updates any dependent template that restates a changed rule.
- Versioning follows semver:
  - MAJOR: removing a rule, or redefining one so that previously compliant code becomes
    non-compliant.
  - MINOR: a new rule or section.
  - PATCH: wording only, with no change in what passes review.
- Every `plan.md` has a Constitution Check that lists each gate from "Pull Request Compliance
  Gates" with pass/fail. `/speckit-analyze` treats any violation of a MUST rule as CRITICAL.
- An exception needs four things in `plan.md` Complexity Tracking: the rule ID, why it can't be
  met, the simpler alternative that was rejected, and a removal date. Exceptions without a removal
  date are rejected.

**Version**: 3.1.0 | **Ratified**: 2026-10-04 | **Last Amended**: 2026-10-04
