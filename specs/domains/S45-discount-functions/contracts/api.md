# Contract: HTTP API of `shop-functions`

All routes under `/api`, JSON, problem+json errors (`type`, `title`, `status`, `detail`, `instance`, `requestId`, `code`; a 5xx has a generic `detail`). Schemas in `packages/contracts/src/shop-functions/` (`shopFunctionSchema`, `shopFunctionVersionSchema`, `shopFunctionTestSchema`, `shopFunctionVersionSummarySchema`, `pageSchema(item)` = `{items, nextCursor}`). Every success body is parsed with its schema in the e2e tests (VII.6). Spec: AS-01 to AS-09, AS-10 to AS-22, AS-37.

**Guards on every route** (order of answers): authentication `401` → member of shop in path else `404` → permission (`FUNCTIONS_PERMISSION`, today `shop.manage`: OWNER, ADMIN; later `functions.manage`) else `403 forbidden` → shop status gate. **Entitlement `shopFunctions`** (`403 entitlement_required {feature}`) on the write routes marked **E**; reads, disable and delete never need it.

| Method and path | Success | Entitlement | Errors (code) |
|---|---|---|---|
| `POST /shops/:shopId/functions` `{name, tests[]}` | `201 shopFunctionSchema` | E | `400 validation_failed`, `422 invalid_test_case`, `409 function_name_taken`, `422 function_limit_reached` |
| `GET /shops/:shopId/functions?limit&cursor` | `200 page(shopFunctionSchema)` | — | `400 validation_failed` (limit > 50), `400 invalid_cursor` |
| `GET /shops/:shopId/functions/:functionId` | `200 shopFunctionSchema` | — | `404 function_not_found` |
| `DELETE /shops/:shopId/functions/:functionId` | `204` | — | `404 function_not_found` |
| `POST …/:functionId/enable` | `200 shopFunctionSchema` | E | `409 function_state_conflict`, `404` |
| `POST …/:functionId/disable` | `200 shopFunctionSchema` | — | `409 function_state_conflict`, `404` |
| `GET …/:functionId/tests` | `200 {tests}` | — | `404` |
| `PUT …/:functionId/tests` `{tests[]}` | `200 {tests}` | E | `400`, `422 invalid_test_case`, `404` |
| `POST …/:functionId/versions` `{source}` | `202 {functionId, version, status:"QUEUED", createdAt}` | E | `400 validation_failed`, `422 version_limit_reached`, `429 rate_limited` (`Retry-After`), `404` |
| `GET …/:functionId/versions?limit&cursor` | `200 page(shopFunctionVersionSummarySchema)` (`version DESC`) | — | `400 invalid_cursor`, `404` |
| `GET …/:functionId/versions/:version` | `200 shopFunctionVersionSchema` | — | `404 version_not_found` / `function_not_found` |
| `POST …/:functionId/versions/:version/activate` | `200 shopFunctionVersionSchema` | E | `409 version_not_activatable`, `404 version_not_found` / `function_not_found` |

A function of another shop, an unknown ID and a malformed-but-valid UUID of a missing function answer the same `404 function_not_found` body (AS-04).

## Bodies

- `shopFunctionSchema`: `{id, shopId, name, enabled, activeVersion: int|null, latestVersion: int|null, testCount, breaker: {state: "CLOSED"|"OPEN"|"HALF_OPEN", openUntil: iso|null, lastFailure: {reason, at}|null}, createdAt, updatedAt}`.
- Test case `shopFunctionTestSchema`: `{name 1–80, input: {currency /^[A-Z]{3}$/, lines 1–50 of {productId, category, quantity int 1–1000, unitPriceMinor int 0–1_000_000_000}}, expected: {discounts: [{lineIndex, type: "percentage"|"fixedPerUnit", value, message ≤ 80}] ≤ 50}}`; suite 1–50 cases, unique names, body ≤ 256 KiB, unknown properties refused (`forbidNonWhitelisted` plus zod `.strict()`).
- `shopFunctionVersionSchema`: `{functionId, version, status, source, sourceHash, verdicts: {case, verdict, detail?, actual?, ms}[] | null, rejectionReason: "judge_unavailable"|null, judgeAttempts, createdBy, createdAt, judgedAt|null, timeline: {status, at, actorId|null, reason|null}[]}`; verdict ∈ `pass|wrong-output|timeout|memory|runtime|invalid-output|compile-error|entry-missing`, `detail ≤ 300`.
- Summary: the version body without `source` and `timeline`.

## Error codes (FR-034)

`validation_failed` (400, offending field named in `errors[]`), `invalid_cursor` (400), `invalid_test_case` (422), `function_not_found` (404), `version_not_found` (404), `function_name_taken` (409), `function_limit_reached` (422), `version_limit_reached` (422), `function_state_conflict` (409), `version_not_activatable` (409), `entitlement_required` (403), `forbidden` (403), `unauthenticated` (401), `rate_limited` (429). No message carries source, test input, discount message, SQL or engine text.

## Rate limit

Policy `shop-functions.submit.shop` (10 per hour per shop, sliding window, fail closed) on the submit route, declared in `api/rate-limit-policies.ts`.
