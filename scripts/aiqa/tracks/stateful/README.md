# Track 9: stateful (rules checked on random input)

Plain words: write down rules that must always be true ("stock is never below 0"), let the computer try thousands of random inputs or action sequences, and shrink any failure to the shortest example.

## (a) Pure logic of the web app (ran, needs no services)

`packages/web/lib/seller/seller-logic.property.test.ts` (fast-check, added to `packages/web` devDependencies). Rules: money text parses by string (round-trips for 0, 2 and 3 decimals, never rounds, never accepts a minus, huge numbers refused, never a float result); stock status boundaries 0 / 1-5 / 6+ and archived overrides; unsupported filter values become defaults, a default filter value is never written in the address and reading the written address gives the same filters, cursors are short URL-safe text or dropped; permissions (only what the list says, adding never removes, every page has a known permission, only ACTIVE shops are writable); `returnTo` keeps path and query, other origins, `//`, backslashes, control characters, encoded tricks and arrays become `/`. Run: `cd packages/web && pnpm exec vitest run lib/seller/seller-logic.property.test.ts`.

## (b) Product lifecycle against the real API and database (written, NOT run)

`packages/backend/libs/domains/catalog/product-lifecycle.stateful.e2e-spec.ts`: fast-check commands (edit a field with the right or a stale `expectedVersion`, set stock, set stock to -1, archive, restore, also in the wrong state) on one product. After every command it compares the member view, the public read (`/api/products/:id`) and the outbox with a small model. Rules: version rises by exactly 1 per accepted change and not at all for a refused or unchanged edit; stock equals the model and is never below 0; an archived product is 404 for buyers; one outbox event per accepted change (events = version) and no impossible row (`impossibleProductRows`); a refused command changes nothing.

It needs the backend test stack (not the dev stack): `pnpm --filter api test:e2e -- libs/domains/catalog/product-lifecycle.stateful.e2e-spec.ts`. Type-checked only so far. Assumptions to confirm on the first run: a refused edit/transition on an archived or wrong-state product answers a 4xx (the spec accepts any 4xx), a stale version answers 409, and the member view names its fields `version`, `quantity`, `status`, `title`, `priceMinor`.
