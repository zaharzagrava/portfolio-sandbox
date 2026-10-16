# HTTP contracts: S04

All under `/api`; errors are `application/problem+json` `{type, title, status, detail, instance, requestId, code}` with the stable codes of spec FR-100. Schemas live in `packages/contracts/src/onboarding/` (strict zod; exported names in spec "Provides"), and every e2e response is parsed with them (`expectContract`, AS-68).

| Method and path | Guard | Request | Success | Errors (code) |
|---|---|---|---|---|
| `PUT /shops/:shopId/onboarding/steps/:step` | `ShopScoped('shop.manage')` | step body per `onboardingStepSchemas[step]` | `200 onboardingView` | 400 `validation_failed` (+`errors[{path,message}]`, includes unknown step), 401, 403 `permission_denied`/`shop_suspended`, 404 `shop_not_found`, 409 `already_submitted`/`shop_offboarding` |
| `GET /shops/:shopId/onboarding` | same | – | `200 onboardingView` | 401, 403, 404 |
| `POST /shops/:shopId/onboarding/submit` | same + policy `onboarding.submit.shop` | – | `200 {submitted:true, submissionNo, requiredDocuments}` | 400 `validation_failed` (`missingSteps` or field path), 429 `rate_limited` |
| `POST /shops/:shopId/onboarding/documents` | same + policy `onboarding.upload.shop` | `{kind, sha256, size, contentType}` strict | `201`/`200 {document, deduplicated, upload\|null}` | 400, 409 `submission_required`/`already_verified`/`resubmission_required`/`document_already_approved`/`document_limit_reached`, 422 `document_not_required`, 429 |
| `POST /shops/:shopId/onboarding/documents/:documentId/uploaded` | same | – | `200 {id, kind, status, rejectionReason}` | 404 `document_not_found`, 409 `upload_not_received`, 422 `upload_mismatch` |
| `GET /admin/onboarding/reviews?kind&limit&cursor` | `Firewall({roles:[ADMIN,MODERATOR], sensitive:true})` | `limit` 1–100 (default 50), opaque cursor over `(createdAt,id)` | `200 {items, nextCursor}` | 400 (bad limit or tampered cursor), 401, 403 `insufficient_role` |
| `POST /admin/onboarding/reviews/:taskId/resolve` | same + conflict-of-interest | discriminated on `decision`: `APPROVE {corrections?}`, `REJECT {reason}`, `REJECT_APPLICATION {reasonCode, reason}` | `200 {status, shopVerified}` | 400, 403 `conflict_of_interest`, 404 `review_task_not_found`, 409 `task_already_resolved`/`document_superseded`/`already_verified`, 422 `iban_invalid`/`vat_invalid`/`missing_fields` |

## Behavioural changes against today (BREAKING defaults of questions.md)

- Step body is validated per step, strict; unknown step name is `400`, not a type hole.
- `GET …/onboarding` keeps the submitted answers after submit; adds `status`, `submissionNo`; `requiredDocuments` is `{kind,status}[]`; `documents` carries only `{id,kind,status,rejectionReason}` and `SUPERSEDED` ones are hidden (select only public columns, A39).
- Review queue returns `{items,nextCursor}`; `shopName` from one `getShopsByIds` call, `null` when absent; `fileUrl` is a 300 s link or `null` after purge; each issued link writes an audit record.
- `reason` required (3–500) on `REJECT`; corrections limited to the fields of the document's kind, values ≤ 500 chars.
- Request responses never contain `storageKey`, sealed or unmasked values, model name, or issue codes to sellers.
