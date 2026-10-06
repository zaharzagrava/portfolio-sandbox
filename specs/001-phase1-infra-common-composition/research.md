# Research & Decisions: Phase 1 Refactor

## R1. Codemod over a plain `mv` {#r1}

- **Decision**: rewrite imports with a resolver-based codemod (`phase1_rewrite_imports.py`) that runs
  against the old layout, then `git mv`.
- **Rationale**: about 940 relative imports crossed folder boundaries, and many imports pointed into
  `models/`. The codemod resolves each specifier to a real file and maps both ends to their new
  locations. It emits a relative path inside one lib and an area alias across libs. Imports where
  neither side moves stay byte-identical, which keeps the diff reviewable.
- **Alternatives considered**: `sed` on alias prefixes (misses relative imports, and is wrong for
  files whose depth changed); the TS language-service "move file" refactor (needs an editor and
  can't be scripted for 38 moves); ts-morph (an extra dependency with no extra accuracy here).

## R2. `@app/common/*` alias with a fallback during the transition {#r2}

- **Decision**: `@app/common/*` → [`libs/common/*`, `libs/common/src/*`] in tsconfig and in Jest.
  esbuild uses a small resolver plugin with the same order.
- **Rationale**: the new pure-utility area and the legacy domains share the `@app/common`
  prefix. A fallback keeps every existing `@app/common/<domain>` import valid without touching
  domain files, which Phase 1 must leave alone. There are no name collisions: none of the new
  common lib names (`config`, `core`, `errors`, …) exists as a folder in `libs/common/src`.
- **Alternatives considered**: re-aliasing domains to `@app/legacy/*` (rewrites about 2k domain
  imports twice, here and again in Phase 2); naming the new area differently (contradicts
  constitution X.3).
- **Exit**: remove the second path entry when Phase 2 empties `libs/common/src` (debt D-5).

## R3. Sub-folders instead of merges {#r3}

- **Decision**: `cron` → `jobs/cron-module`, `request` → `http-client/request`,
  `outbox-dto` → `outbox/dto`, `db-utils` → `database/db-utils`, `config-utils` →
  `config/config-utils`, `error-utils` → `errors/error-utils`.
- **Rationale**: these keep the move purely mechanical (no file merges, no export reshaping), and
  every destination is still the lib the domain map names. Flattening them is a follow-up
  cleanup. `cron-module` avoids sitting next to the existing `jobs/cron.ts`, which would make
  `./cron` ambiguous to readers.

## R4. `batch-read.controller.ts` stays out of composition {#r4}

- **Decision**: leave it at `libs/common/src/bff/batch-read.controller.ts`.
- **Rationale**: it runs raw SQL against the `Shop` and `Product` tables inside `core`. X.8.1
  forbids data access in composition, and IX.4 forbids one module reading two domains' tables.
  Its correct home is batch endpoints in tenancy and catalog (Phase 2, debt D-4).

## R5. `api-config.service.mock.ts` `.env` path {#r5}

- **Decision**: change `'../../.env*'` to `'../../../.env*'` so it resolves to
  `packages/backend/.env*`.
- **Rationale**: the comment states the intent ("we get .env from backend folder"). The old path
  resolved to `libs/common/.env*`, which doesn't exist, so it was already broken. Keeping the
  same relative string after the move would have pointed at `libs/.env*`. This is the only
  semantic change in Phase 1.

## R6. Technical-table models move with their infrastructure lib {#r6}

- **Decision**: `models/outbox.model.ts` → `infrastructure/outbox/`, and
  `models/migration.model.ts` → `infrastructure/database/`. `all-models.ts` stays (Phase 2 deletes
  it) and imports them through the new aliases.
- **Rationale**: constitution IX.3 makes these tables infrastructure-owned, and X.3 lets
  infrastructure hold only the technical-allowlist tables.
