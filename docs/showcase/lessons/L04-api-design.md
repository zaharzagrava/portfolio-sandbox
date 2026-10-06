# L04 — API Design → where it's used

| Topic (notes 04/01–03) | Implemented in | Status |
|---|---|---|
| HTTP/2 between BFF and services | SD-04 | planned |
| Aggregate endpoints, BFF | SD-04 | planned |
| `expand` / sparse fieldsets | SD-07 | planned |
| Batch / bulk endpoints | SD-07 `/v1/batch`, bulk stock | planned |
| GraphQL + DataLoader + complexity limits | SD-04 | planned |
| Push instead of poll (SSE) | F-03 | planned |
| Async request-reply (202 + status / SSE) | existing #5; SD-19 checkout; SD-27 imports | planned |
| CQRS read models | F-05 | planned |
| Problem Details (RFC 9457), stable error codes | F-01 | planned |
| HTTP caching (ETag, `Cache-Control`, `stale-while-revalidate`) | SD-34, SD-05 | planned |
| Versioning (URI + date-pinned), multiple versions in Nest | SD-07 | planned |
| Deprecation policy, `Deprecation`/`Sunset` headers, telemetry, ownership doc | SD-07 + `docs/api-deprecation-policy.md` | planned |
| Webhook & event versioning | SD-30 | planned |
| Idempotency keys | existing #3 store reused by SD-07, SD-19, SD-21, SD-22 | planned |
| Pagination (cursor) | all list endpoints | planned |
| Rate limiting as provider (algorithms, headers) | SD-28 | planned |
| Consuming rate-limited APIs | SD-36, SD-42 | planned |
| Providing webhooks / consuming webhooks | SD-30 / SD-19 (Stripe), SD-17 (provider status), SD-36 | planned |
