# Contract: problem document (`packages/contracts/problem.ts`)

Media type `application/problem+json` (RFC 9457). Produced only by the global `AllExceptionsFilter` (V.3).

```ts
export const problemDetailsSchema = z.object({
  type: z.string().url(),            // `${problem_type_base_url}/${code}`
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),                // 5xx: fixed catalogue text
  instance: z.string(),              // path without query; route template for @SensitivePathParams
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  requestId: z.string(),             // equals X-Request-Id response header
  traceId: z.string().optional(),
  errors: z.array(z.object({ field: z.string(), code: z.string() })).optional(), // validation_failed only
}).catchall(z.unknown());            // registered extensions only; reserved members cannot be overridden
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
```

Never present: `area`, `data`, `causes`, `stack`, `supportTraceId`, SQL, constraint or column names, upstream messages, input values.

## Platform codes (owner S54)

| code | status | notes |
|---|---|---|
| `internal_error` | 500 | default for unregistered/unknown errors |
| `bad_request` | 400 | |
| `validation_failed` | 400 | `errors[{field, code}]`, no values |
| `malformed_body` | 400 | |
| `payload_too_large` | 413 | |
| `unsupported_media_type` | 415 | |
| `unauthenticated` | 401 | preserves `WWW-Authenticate` |
| `forbidden` | 403 | |
| `not_found` | 404 | |
| `method_not_allowed` | 405 | preserves `Allow` |
| `conflict` | 409 | raw unique violation (generic text) |
| `idempotency_in_flight` | 409 | `Retry-After: 1` |
| `idempotency_replay_unavailable` | 409 | stored body over 256 KiB |
| `idempotency_key_required` | 422 | |
| `idempotency_key_invalid` | 422 | |
| `idempotency_key_reuse` | 422 | different fingerprint |
| `service_overloaded` | 503 | `Retry-After` 1–3 randomised, `Connection: close` |
| `dependency_unavailable` | 503 | breaker open / bulkhead full / deadline |
| `transaction_conflict` | 503 | `Retry-After: 1` |
| `database_timeout` | 503 | SQLSTATE 57014 |
| `db_lock_timeout` | 503 | SQLSTATE 55P03 |
| `database_unavailable` | 503 | pool acquire timeout |
| `idempotency_unavailable` | 503 | store down, fail closed |

Capabilities add codes via `ProblemCatalogModule.forFeature([{ code, status, title, detail }])`; the same code with a different definition fails startup, naming both owners.

## Headers

`Retry-After`, `WWW-Authenticate`, `Allow` come from the thrown error and are preserved. `X-Request-Id` is always set. `Content-Type: application/problem+json`.

## Rendering failure fallback

If building or serialising fails, or headers were already sent: when headers are not sent, write `{"type":"<base>/internal_error","title":"Internal Server Error","status":500,"detail":"An unexpected error occurred.","instance":"<path>","code":"internal_error","requestId":"<id>"}`; when sent, write nothing and destroy the socket. The filter never throws.
