# Research & Decisions: Phase 2 (batch 1)

## R1. An explicit file-level move map instead of folder moves {#r1}

- **Decision**: `phase2-moves.tsv` assigns every file (or leaf sub-folder) to a layer, guarded by a
  coverage check that fails if any file in a batch folder is unmapped.
- **Rationale**: a layer is a per-file property. One `product/` folder holds a controller (api), a
  service (application), projectors (infra), and DTOs (api). A reviewable table makes each
  classification visible in the PR diff.
- **Classification rules**:
  - `api/`: controllers, guards, decorators, request/response DTOs, WebSocket servers.
  - `application/`: use-case services.
  - `domain/`: pure logic.
  - `infra/`: models, repositories, adapters, projectors, job handlers.
  - Domain root: Nest modules and e2e specs.
- **Alternatives considered**: heuristic classification by file suffix (it misses `room.ts`,
  `permissions.ts`, and `collab-ticket.ts`); moving folders whole into `application/` (that
  violates I.1 and only postpones the work).

## R2. Two-pass import rewrite {#r2}

- **Decision**: pass 1 (`rewrite_imports.py`, the same resolver as Phase 1) produces correct deep
  `@app/domains/<d>/…` paths and relative paths inside a domain. Pass 2
  (`phase2-entrypoints.ts`, TS compiler API) turns cross-domain deep imports into barrel imports.
- **Rationale**: pass 1 needs only path resolution. Pass 2 needs symbol information: whether each
  name is a value or a type (for `isolatedModules`) and the declared name of default exports. Doing
  both in the TS API would make the move step depend on a type-checkable tree mid-move.

## R3. Barrels contain exactly what is used {#r3}

- **Decision**: `index.ts` re-exports only symbols that outside code actually imports. Values use
  `export { }`, type-only symbols use `export type { }`.
- **Rationale**: this gives the minimal public surface (X.4), makes coupling visible (every model
  export is an IX.4 debt item), and avoids `export *` name collisions.
- **Alternatives considered**: `export *` from every file (collides on `User`, and exposes
  internals); hand-written barrels (they miss symbols, and `tsc` would catch those only one at a
  time).

## R4. Re-export models as `<Name>Model` {#r4}

- **Decision**: default-exported models are exported as `UserModel`, `ShopModel`, `ProductModel`,
  and so on. Consumers keep their local names: `import { UserModel as User }`.
- **Rationale**: `identity` exports both the `User` model and the `@User()` decorator. The suffix
  also tags every model export as transitional (IX.4: no other domain should inject it), which
  makes them easy to find when paying down D-7.

## R5. Keep one Nest module per former folder {#r5}

- **Decision**: `identity` keeps `AuthModule`, `AuthApiModule`, `AuthWorkerModule`, `UsersModule`,
  `UsersDtoModule`, `UserUtilsModule`, and `AdminModule` side by side.
- **Rationale**: merging modules changes provider instantiation and import graphs, which is
  runtime behavior that can't be verified without booting apps (D2). It's a follow-up.

## R6. Module-graph check as the runtime guard {#r6}

- **Decision**: `scripts/check-module-graph.ts` `require`s every app root module under plain Node.
  It recursively walks `imports`, `providers`, `controllers`, `exports`, and dynamic modules, and it
  reports any `undefined` entry or `undefined` constructor parameter type.
- **Rationale**: barrels create new circular-import paths. When a cycle evaluates late, a decorator
  captures `undefined`. `tsc` passes, and Nest fails only at boot. The check runs without a DB or
  network, so it's allowed under D2. It runs under Node rather than Jest because Jest's runtime
  can't `require` the ESM-only dependencies (Node 24 can).
- **Result**: 9/9 apps had identical visit counts before and after.

## R7. Registry format and enforcement {#r7}

- **Decision**: a typed `as const satisfies Record<string, Owner>` map plus a Jest spec. The spec:
  - parses the migrations (`createTable`, `CREATE TABLE`, `RENAME TO`; partition children and
    `_new` staging copies fold into their parent; retired tables like `Inventory` are excluded);
  - checks completeness in both directions, valid owners, and the exact technical allowlist;
  - checks that every migrated model's file lives in the lib that owns its table.
- **Rationale**: this is falsifiable and runs in the normal unit suite (VII.1/IX.5). Model
  placement turns the registry from documentation into a structural constraint. A mutation test
  confirmed the spec fails on a wrong owner.
- **Open item**: `ProcessedWebhookEvent` is owned by `infrastructure:idempotency` (the "inbox /
  processed-events" role in IX.3), because there's no `inbox` lib. If you create an inbox lib,
  change both the registry and its allowlist entry.
