# Contract: Boundary Enforcement and Shared Ports

## `pnpm check:boundaries` (`packages/backend/.dependency-cruiser.cjs`)

| Rule | Constitution | Severity |
|---|---|---|
| `x1-nothing-imports-apps` | X.1 | error |
| `x6-production-never-imports-test` | X.6 (tests live in `test/`) | error |
| `x5-infrastructure-is-domain-agnostic` | X.3, X.5 | error |
| `x5-common-imports-only-common` | X.5 | error |
| `x8-composition-never-imports-domains` | X.8.2 | error |
| `x8-composition-infrastructure-allowlist` | X.8.4 | error |
| `x5-domains-never-import-composition` | X.5 | error |
| `x4-domain-entry-point-only` | X.4 | error |
| `x4-other-domain-entry-point-only` | X.4 | error |
| `x5-no-circular` | X.5 | **warn**: recorded debt D-11, D-12, D-15, D-17; raise to error once it's paid |

Spec files (`*.spec.ts`, `*.e2e-spec.ts`) are exempt from the production-only rules.

## New shared contracts

| Export | Path | Purpose |
|---|---|---|
| `TestCleanupPort`, `TEST_CLEANUP` | `@app/common/testing/test-cleanup.port` | Infrastructure registers test cleaners. `test/utils` binds the token to its registry. Production never provides it. |
| `TopicRegistry`, `TopicDefinition`, `TopicPolicy`, `TopicViewer` | `@app/infrastructure/realtime/topic-registry` | Domains define realtime topics (prefix, suffixes, singleton, policy); the gateway validates and authorizes. |
| `decodeCursor(raw, isKnownTopic)` | `@app/infrastructure/realtime/topics` | Now takes the validator (the registry) instead of a hard-coded pattern. |
| `AppClsStore`, `REQUEST_ID_HEADER` | `@app/common/request-context/types` | The request-context contract (moved from infrastructure). |
| `RequestWithUser` | `@app/domains/identity` | Moved from the legacy `types.ts`. |
| `parseIdList` | `@app/infrastructure/platform/parse-id-list` | `?ids=` parsing for batch reads. |
| `<Domain>TopicsModule` ×9, `ShopBatchReadModule`, `ProductBatchReadModule` | domain barrels | Imported by sse-gateway (topics) and core (batch reads). |

## Route contract (unchanged)

`GET /api/batch/shops?ids=` (max-age 30) and `GET /api/batch/products?ids=` (max-age 10): same response
shapes, same 1–100 UUID validation, served by core and local-monolith only.
