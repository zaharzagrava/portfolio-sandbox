# Contract — backend additions (`packages/backend`, schemas in `packages/contracts`)

## `POST /api/csp-reports` (S54 platform toolkit)

- Anonymous. Accepts `application/csp-report`, `application/reports+json`, `application/json`.
- Always `204 No Content`, including for an empty, oversized, malformed or wrong-content-type body (the browser must never see an error).
- Logs only the violated directive and the blocked host (scheme + host); never the document URL query. Rate limited with the S54 throttle (over the limit still `204`, report dropped; the limiter's own refusal is the `429` case the e2e spec asserts if the toolkit answers it).
- No DB access, no transaction.
- e2e (`*.e2e-spec.ts`, real app pipeline, `supertest`): both report formats → `204` and a log entry with directive and host; garbage body → `204`; wrong content type → `204`; over-limit behaviour; no URL query in the log.

## `GET /api/developers/openapi.json` (public API description)

- Returns the OpenAPI 3.x document of the public API (`application/json`), same content the public-api app serves at `docs-json`.
- Errors as problem+json through the global filter.
- Contract: `openApiDocumentSchema` (`openapi` starts with `3.`, `paths` object) in `packages/contracts`; the e2e spec parses the response with it.
- Web proxy: rewrite `/api/developers/openapi.json` → `${PUBLIC_API_URL}/docs-json` before the generic `/api/:path*` rule.
