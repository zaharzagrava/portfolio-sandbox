# Track "stateful": rules that must always hold, tried on thousands of random inputs

Plain words: write the rule once ("stock is never below 0", "an archived product is never shown to buyers") and let the computer try thousands of random inputs or random action sequences; if a rule breaks it shrinks the failure to the shortest example. Example: "edit, archive, restore, edit with an old version" in that order breaks the version rule: you get exactly those four steps.

## What this finds that the other tracks miss

Orderings and values nobody thought of. Hand-written tests try the cases a person imagined; random sequences find the 4-step combination.

## Prerequisites

- (a) pure logic of the web app: nothing running (Vitest + fast-check).
- (b) product lifecycle: the backend TEST stack (not the dev stack; swap stacks, never both): `pnpm --filter api test:e2e -- libs/domains/catalog/product-lifecycle.stateful.e2e-spec.ts`.
- Memory: the backend test stack (Postgres, Redis and friends); one stack at a time.

## How to point it at a NEW feature

1. Pure logic: add a property to `packages/web/lib/seller/seller-logic.property.test.ts` for each pure function of the feature (parser round trips, never-negative numbers, filter defaults, permission lists).
2. Server behaviour: copy `product-lifecycle.stateful.e2e-spec.ts`: list the commands a user can issue on the entity (edit with right/stale version, set stock, archive, restore, also in the wrong state), a small model of what the state must be, and the invariants checked after every command (version +1 per accepted change, stock >= 0, public read hides archived, one outbox event per change, no impossible rows; see `libs/domains/catalog/testing/catalog-invariants.ts`).
3. Add map lines for the rules (`<area>.stateful.<rule>`) with the spec ids; annotate the property/test with them.

## Commands

```
cd packages/web && pnpm exec vitest run lib/seller/seller-logic.property.test.ts
pnpm --filter api test:e2e -- libs/domains/catalog/product-lifecycle.stateful.e2e-spec.ts     # backend test stack
```

## How to read the results

A failure prints the shortest sequence and the random seed; replay with the seed. A passing run says "no counter-example in N tries", not "proved".

## How results become map lines, findings and register entries

A failing rule is a finding (the printed sequence is the steps) and a register entry; the test stays failing until fixed. Passing rules mark their map lines `pass` with layers `api,db` (pure logic: `unit`).

## Known limits

Part (b) is type-checked only: the assumptions listed in the details below (4xx on refused commands, 409 on a stale version, field names) must be confirmed on the first run. Screens have no random-action runner yet except the monkey tester in `scripts/qa/`.

## Details (from the first version of this README)

## Track 9: stateful (rules checked on random input)

Plain words: write down rules that must always be true ("stock is never below 0"), let the computer try thousands of random inputs or action sequences, and shrink any failure to the shortest example.

### (a) Pure logic of the web app (ran, needs no services)

`packages/web/lib/seller/seller-logic.property.test.ts` (fast-check, added to `packages/web` devDependencies). Rules: money text parses by string (round-trips for 0, 2 and 3 decimals, never rounds, never accepts a minus, huge numbers refused, never a float result); stock status boundaries 0 / 1-5 / 6+ and archived overrides; unsupported filter values become defaults, a default filter value is never written in the address and reading the written address gives the same filters, cursors are short URL-safe text or dropped; permissions (only what the list says, adding never removes, every page has a known permission, only ACTIVE shops are writable); `returnTo` keeps path and query, other origins, `//`, backslashes, control characters, encoded tricks and arrays become `/`. Run: `cd packages/web && pnpm exec vitest run lib/seller/seller-logic.property.test.ts`.

### (b) Product lifecycle against the real API and database (written, NOT run)

`packages/backend/libs/domains/catalog/product-lifecycle.stateful.e2e-spec.ts`: fast-check commands (edit a field with the right or a stale `expectedVersion`, set stock, set stock to -1, archive, restore, also in the wrong state) on one product. After every command it compares the member view, the public read (`/api/products/:id`) and the outbox with a small model. Rules: version rises by exactly 1 per accepted change and not at all for a refused or unchanged edit; stock equals the model and is never below 0; an archived product is 404 for buyers; one outbox event per accepted change (events = version) and no impossible row (`impossibleProductRows`); a refused command changes nothing.

It needs the backend test stack (not the dev stack): `pnpm --filter api test:e2e -- libs/domains/catalog/product-lifecycle.stateful.e2e-spec.ts`. Type-checked only so far. Assumptions to confirm on the first run: a refused edit/transition on an archived or wrong-state product answers a 4xx (the spec accepts any 4xx), a stale version answers 409, and the member view names its fields `version`, `quantity`, `status`, `title`, `priceMinor`.
