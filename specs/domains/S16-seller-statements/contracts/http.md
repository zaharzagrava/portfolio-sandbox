# HTTP contract: S16 statements

Schemas live in `packages/contracts/src/statements/` (`rates.ts`, `statements.ts`, `periods.ts`, `findings.ts`) and are the single source for DTO validation (zod pipe) and for e2e response parsing (VII.6). Shapes are those of `spec.md` § Provides → HTTP; this file adds routing, guards, policies and problem codes.

| Route | Guard | Policy (fail mode) | Success | Problems |
|---|---|---|---|---|
| `GET /shops/:shopId/statements?limit&cursor` | `ShopScoped('payouts.read')` | `statements.read` 120/min/user (open) | 200 `statementPageSchema` | `validation_failed` 400, `invalid_cursor` 400, `shop_not_found` 404, `permission_denied` 403, `rate_limited` 429 |
| `GET /shops/:shopId/statements/:month?knownAt` | `ShopScoped('payouts.read')` | `statements.read` | 200 `statementSchema` | + `month_not_available` 422, `known_at_in_future` 422 |
| `GET /shops/:shopId/statements/:month/lines.csv?knownAt` | `ShopScoped('payouts.read')` | `statements.read` + `statements.export.concurrent` 2/shop (closed) | 200 `text/csv` | + `rate_limited` 429, 503 when the limiter store is down |
| `POST /admin/commission-rates` | `Firewall({roles:[ADMIN]})`, `@Idempotent()` | `statements.admin.write` 30/min (closed) | 201 new / 200 no-op `commissionRateChangeResultSchema` | `validation_failed` 400, `rate_range_invalid` 422, `default_rate_gap` 422, `shop_not_found` 404, `idempotency_key_required` / `idempotency_key_reuse` 422, `idempotency_in_flight` 409, `permission_denied` 403 |
| `GET /admin/commission-rates?shopId&category&limit&cursor` | Admin | `statements.admin.read` 120/min (open) | 200 `commissionRateHistoryPageSchema` | `validation_failed`, `invalid_cursor` 400 |
| `GET /admin/commission-rates/as-of?shopId&category&validAt&knownAt` | Admin | `statements.admin.read` | 200 `commissionRateAsOfSchema` | `validation_failed`, `known_at_in_future` 422 |
| `GET /admin/accounting-periods?limit&cursor` | Admin | `statements.admin.read` | 200 page of `accountingPeriodSchema` | `invalid_cursor` |
| `GET /admin/accounting-periods/:month` | Admin | `statements.admin.read` | 200 `accountingPeriodSchema` | `validation_failed`, `month_not_available` |
| `POST /admin/accounting-periods/:month/close` | Admin, `@Idempotent()` | `statements.admin.write` | 202 `{month, status:"CLOSING", runId}` | `period_not_ended`, `period_not_ready` (`details {stream, watermark}`), `previous_period_open` (`details {month}`), `period_closed`, `period_closing`: all 409 |
| `GET /admin/accounting-periods/:month/findings?limit&cursor` | Admin | `statements.admin.read` | 200 `reconciliationFindingPageSchema` | `invalid_cursor` |

Rules:

- No `reopen` route and no DELETE routes exist (AS-34, AS-76). No credentials answer `401` on all routes; a non-admin on `/admin/…` answers `403 permission_denied`; a non-member on a seller route answers `404 shop_not_found`, identical to an unknown shop (decided by `ShopScoped`, never by the controller).
- Path and query validation is done by zod pipes in `api/statements.dto.ts`: month `^\d{4}-(0[1-9]|1[0-2])$`, `knownAt` `z.string().datetime({offset:true})`, `limit` 1–36 (seller list, default 12) and 1–100 (admin, default 20), cursors opaque base64url JSON validated by `domain/cursor.ts` (`invalid_cursor`). Bounds that need the clock (`month_not_available`, `known_at_in_future`) are checked in the application service.
- `GET`s write nothing: no cache entry, no outbox row, no job (AS-26).
- CSV headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="statement-<shopId>-<month>.csv"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; first line `rowType,orderId,lineId,paidAt,productId,category,quantity,unitPriceMinor,lineTotalMinor,rateBps,commissionMinor,refersToMonth,bookedMonth,cause`.
- Compatibility (V.7): the old fields `gross/commission/net/lines` and the `204` of the rate POST are replaced; no web consumer exists yet (D7), so the break is recorded in the living page.
