# OWASP API Security Top 10 (2023) — the seller public API

Capability S42 (`developer-platform`, deployable `apps/public-api`). Every row names the control that addresses the risk,
the acceptance scenarios of [`specs/domains/S42-public-api/spec.md`](../../specs/domains/S42-public-api/spec.md) whose tests prove
it, and the owner of the control. A test (`public-api-contract.e2e-spec.ts`, AS-68) checks that every scenario named here exists
in the spec and that every row has an owner.

| Risk | Control | Scenarios | Owner |
|---|---|---|---|
| API1 Broken object level authorization | The shop comes only from the verified key; every lookup of a shop-owned record carries it in the same query or service call; another shop's record is `404 resource_missing`, indistinguishable from an unknown id; cursors are bound to their shop | AS-16 | `developer-platform` |
| API2 Broken authentication | One refusal (`401 invalid_api_key`) for every bad credential; keys are random, stored as a keyed hash (dedicated pepper, never the JWT secret), compared in constant time, revocable at once, expiring; failed authentications are throttled per address and counted by reason; the pepper is mandatory | AS-13, AS-14, AS-20 | `developer-platform` |
| API3 Broken object property level authorization | Every response is built from an explicit public DTO per version (no internal column, hash, secret or buyer datum); `fields` and `expand` are allowlists; writes accept only the declared properties (unknown ones are refused) | AS-28, AS-38, AS-42 | `developer-platform` |
| API4 Unrestricted resource consumption | Per-key token bucket with cost (a batch costs its operations, bulk stock `⌈items ÷ 100⌉`), a plan quota, 2 MiB bodies, `limit` 1…100 with no clamping, 1–50 batch operations with a 10 s budget, 10,000 bulk items in 100-item chunks | AS-44, AS-48, AS-55, AS-57, AS-66 | `developer-platform` |
| API5 Broken function level authorization | Each route declares one scope, checked after authentication and before any work; every batch operation is checked against the scope of its own route; dashboard routes need a session and `shop.manage`, with a second factor for live keys | AS-15, AS-45 | `developer-platform` |
| API6 Unrestricted access to sensitive business flows | Key creation is limited to 25 active keys per shop by the store, concurrent creators included; creating requests need an `Idempotency-Key` scoped to the acting shop and route; stock changes are deltas with operation ids that apply once | AS-05, AS-53 | `developer-platform` |
| API7 Server side request forgery | No feature fetches a client-supplied URL: batch paths must match `^/v1/[\w/-]+$` and name this API's own routes; webhooks (another capability) have their own host rules | AS-44 | `developer-platform` |
| API8 Security misconfiguration | Problem documents with stable codes and generic `5xx` details; body limits and media types enforced before a handler; `Cache-Control: no-store`, `nosniff`, no CORS grant, no cookies, no framework banner | AS-65, AS-66, AS-69 | `developer-platform` and the platform HTTP bootstrap (S54) |
| API9 Improper inventory management | One version registry with a lifecycle and a deprecation registry drive the headers, the `410`s, the telemetry and the OpenAPI description; the contract is checked against real responses for every supported version | AS-32, AS-33, AS-34, AS-35, AS-36, AS-67 | `developer-platform` |
| API10 Unsafe consumption of APIs | Everything obtained from another capability (products, stock, orders, shops) comes through its exported service and is mapped into a public DTO; its refusals are translated into this API's catalogue; a stock result is validated by operation | AS-50, AS-51 | `developer-platform` |

## Secrets

Keys, key secrets and `Authorization` values appear in no log, request record, event, error, metric label or trace (AS-19).
The key's `prefix` is shown only in the dashboard list and in the creation response.

## Where the controls are

- Authentication, lifecycle, version, content, scope and quota guards: `libs/domains/developer-platform/api/*.guard.ts`
- Keys and their transitions: `application/api-keys.service.ts`, `infra/sequelize-api-key.repository.ts`
- Rate limits and their cost: `rate-limit-policies.ts`, `api/bulk-stock.controller.ts`, `api/batch.controller.ts`
- Contract and OpenAPI: `packages/contracts/src/developer-platform`, `application/openapi.builder.ts`
