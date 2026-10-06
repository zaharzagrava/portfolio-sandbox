# Test Plan: S04 — Seller Onboarding / KYC (domain `seller-onboarding`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (72 of 72), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/seller-onboarding/`. Each file's top-level `describe` names its feature (VII.8): `describe('Seller onboarding: staged questionnaire (e2e)')`, `…: document intake`, `…: AI extraction`, `…: human review`, `…: verification and view`, `…: retention`, `…: boundaries and observability`. They boot the real `OnboardingModule`, `OnboardingExtractionModule` and `OnboardingWorkerModule` (plus the identity and tenancy modules and the outbox, rate limiter and jobs they need) with the production global pipe, filter, prefix and interceptors, call HTTP through `supertest`, and run against real Postgres (migrated), Redis and object storage from `docker-compose.test.yaml`. Repositories, ORM, secret box, outbox and job tables are real.
- Only system-edge dependencies are faked: the **scripted LLM provider** (`ScriptedLlmProvider`: records model, tools, schema, timeout; can delay, time out, return 429/5xx, return malformed or hostile answers), the queue transport (the outbox row is the asserted artefact; the extraction worker is driven by calling `ExtractionService.process` and, for AS-34, the Lambda `handler` with an SQS event), the storage backend (in-memory object storage with fault injection), and the clock (frozen and advanced). Fault injection for AS-53 uses a real Postgres trigger that fails one outbox insert.
- Every test asserts the response body **and** the persisted state (rows, outbox rows, jobs, Redis keys, storage objects). Tenancy is exercised through its real exported services; shops and memberships are seeded through the shared fixture helpers in `test/seeds` (never through models inside the spec).
- Consumers (`tenancy.shop_deleted`, the extraction message, the dead-letter handler) have the VII.4 pair: same message twice → one effect; invalid payload → rejected or dead-lettered with no side effect (rows AS-32, AS-34, AS-60).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): extraction rules, file-type detection, status machines, validators (with a `fast-check` property for mod-97), questionnaire rules, configuration schema. No unit tests for controllers, services or glue.
- UI journeys: `packages/web/tests/seller-onboarding.spec.ts` (Playwright; screens owned by the web capabilities, seller side with W04 and moderator side with the admin console) — three happy paths only: seller completes the wizard and submits, seller uploads documents and sees "Verified", moderator corrects an IBAN and approves. No edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (the `seller-onboarding` block must be empty, AS-62); `pnpm check:model-registry`.
- Contract layer (VII.6): every e2e response is parsed with its `packages/contracts` schema through the shared `expectContract(schema, body)` helper; AS-68 additionally fails the build if an endpoint of the route table has no schema.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 save a valid step: view, draft key and TTL, no row, no event | `onboarding-questionnaire.e2e-spec.ts` | `seller-onboarding.spec.ts` (fill the four steps) | — |
| AS-02 per-step validation classes, unknown step, unknown field, body shape | `onboarding-questionnaire.e2e-spec.ts` (table-driven over steps) | — | — |
| AS-03 sliding TTL, step independence, concurrent saves, expiry | `onboarding-questionnaire.e2e-spec.ts` (`Promise.all`, key deletion) | — | — |
| AS-04 submit refused: missing steps, cross-step rules, nothing persisted | `onboarding-questionnaire.e2e-spec.ts` | — | — |
| AS-05 submit success: row, outbox event, draft dropped, no shop write | `onboarding-questionnaire.e2e-spec.ts` | `seller-onboarding.spec.ts` (submit, see required documents) | — |
| AS-06 submit idempotent and concurrent | `onboarding-questionnaire.e2e-spec.ts` (`Promise.all` ×5) | — | — |
| AS-07 no edits after submit or verification | `onboarding-questionnaire.e2e-spec.ts` | — | — |
| AS-08 401, cross-tenant 404, permission 403, suspended gate, draft isolation | `onboarding-questionnaire.e2e-spec.ts` (route table) | — | — |
| AS-09 onboarding view in every state, contract parse | `onboarding-questionnaire.e2e-spec.ts` | — | — |
| AS-10 upload before submit → 409 | `onboarding-documents.e2e-spec.ts` | — | — |
| AS-11 request upload: body, grant, row | `onboarding-documents.e2e-spec.ts` | `seller-onboarding.spec.ts` (upload registration and statement) | — |
| AS-12 request validation classes | `onboarding-documents.e2e-spec.ts` (table-driven) | — | — |
| AS-13 kind not required → 422 | `onboarding-documents.e2e-spec.ts` | — | — |
| AS-14 de-duplication and concurrent identical requests | `onboarding-documents.e2e-spec.ts` (`Promise.all` ×5) | — | — |
| AS-15 confirm upload: status, outbox command, replay | `onboarding-documents.e2e-spec.ts` | — | — |
| AS-16 confirm without object, size mismatch | `onboarding-documents.e2e-spec.ts` | — | — |
| AS-17 a newer file supersedes unresolved ones, tasks cancelled | `onboarding-documents.e2e-spec.ts` | — | — |
| AS-18 approved kind, verified and rejected application gates | `onboarding-documents.e2e-spec.ts` | — | — |
| AS-19 five documents per kind per round | `onboarding-documents.e2e-spec.ts` | — | — |
| AS-20 upload and submit rate limits → 429 | `onboarding-documents.e2e-spec.ts` (real limiter, frozen clock) | — | — |
| AS-21 cross-tenant document access → 404 | `onboarding-documents.e2e-spec.ts` | — | — |
| AS-22 happy path: one cheap call, no tools, schema, approved | `onboarding-extraction.e2e-spec.ts` | — | — |
| AS-23 rule outcomes, escalation flags, boundary dates | — | — | `domain/extraction-rules.spec.ts` (`it.each` per issue code and boundary) |
| AS-24 escalation fixes a misread (two attempts) | `onboarding-extraction.e2e-spec.ts` | — | — |
| AS-25 escalation exhausted → review | `onboarding-extraction.e2e-spec.ts` | — | — |
| AS-26 prompt-injected document: name mismatch, no escalation, not verified | `onboarding-extraction.e2e-spec.ts` | — | — |
| AS-27 malformed or hostile model output → `invalid_output`, empty tool list | `onboarding-extraction.e2e-spec.ts` (table-driven answers) | — | — |
| AS-28 file type detection by magic bytes | — | — | `domain/file-type.spec.ts` (`it.each`) |
| AS-29 declared type ≠ bytes → review, no model call | `onboarding-extraction.e2e-spec.ts` | — | — |
| AS-30 masked view, sealed values bound to row, no PII in logs | `onboarding-extraction.e2e-spec.ts` (captured log stream) | — | — |
| AS-31 redelivery, concurrent workers, resume at attempt 2, no-op messages | `onboarding-extraction.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-32 provider failure, lease expiry, dead-letter routing | `onboarding-extraction.e2e-spec.ts` (frozen clock advanced past the lease) | — | — |
| AS-33 superseded during extraction: result discarded | `onboarding-extraction.e2e-spec.ts` | — | — |
| AS-34 invalid queue payloads as failed batch items | `onboarding-extraction.e2e-spec.ts` (Lambda `handler` with an SQS event) | — | — |
| AS-35 missing object → review; transient storage error propagates | `onboarding-extraction.e2e-spec.ts` | — | — |
| AS-36 per-call usage record, metering failure tolerated | `onboarding-extraction.e2e-spec.ts` | — | — |
| AS-37 queue listing: shape, masking, order, link or null, filter | `onboarding-review.e2e-spec.ts` | — | — |
| AS-38 queue keyset pagination, limit cap, tampered cursor | `onboarding-review.e2e-spec.ts` (120 tasks) | — | — |
| AS-39 401, 403 for non-staff, revoked session on a sensitive route | `onboarding-review.e2e-spec.ts` | — | — |
| AS-40 approve as-is | `onboarding-review.e2e-spec.ts` | — | — |
| AS-41 approve with corrections, masked pairs, counters | `onboarding-review.e2e-spec.ts` | `seller-onboarding.spec.ts` (moderator corrects IBAN and approves) | — |
| AS-42 hard checks, required fields, invalid corrections | `onboarding-review.e2e-spec.ts` (table-driven) | — | — |
| AS-43 reject a document: reason, event, seller sees it | `onboarding-review.e2e-spec.ts` | — | — |
| AS-44 two reviewers, one winner | `onboarding-review.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-45 stale, resolved, unknown, malformed task | `onboarding-review.e2e-spec.ts` | — | — |
| AS-46 reject the application | `onboarding-review.e2e-spec.ts` | — | — |
| AS-47 conflict of interest | `onboarding-review.e2e-spec.ts` | — | — |
| AS-48 audit records without personal data | `onboarding-review.e2e-spec.ts` (captured audit stream) | — | — |
| AS-49 verification in the approving transaction: event, purge job, no shop write | `onboarding-verification.e2e-spec.ts` | `seller-onboarding.spec.ts` (seller sees "Verified") | — |
| AS-50 partial or non-required approvals do not verify | `onboarding-verification.e2e-spec.ts` | — | — |
| AS-51 last two approvals racing → one verification | `onboarding-verification.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-52 `VERIFIED` is final | `onboarding-verification.e2e-spec.ts` | — | — |
| AS-53 outbox failure rolls the approval back, retry completes | `onboarding-verification.e2e-spec.ts` (Postgres trigger fault) | — | — |
| AS-54 event envelope and payload contracts, nothing emitted on 4xx | `onboarding-verification.e2e-spec.ts` | — | — |
| AS-55 seller view: statuses only, no extracted data | `onboarding-verification.e2e-spec.ts` | — | — |
| AS-56 resubmission after rejection: draft from last answers, round 2 | `onboarding-questionnaire.e2e-spec.ts` | — | — |
| AS-57 same file in round 2, concurrent resubmissions | `onboarding-questionnaire.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-58 purge after verification: files deleted, sealed kept, idempotent, partial failure | `onboarding-retention.e2e-spec.ts` | — | — |
| AS-59 purge after rejection, later round untouched | `onboarding-retention.e2e-spec.ts` | — | — |
| AS-60 `tenancy.shop_deleted` consumer: purge now, erase scheduled, duplicate, invalid | `onboarding-retention.e2e-spec.ts` | — | — |
| AS-61 erase job at due time only | `onboarding-retention.e2e-spec.ts` (frozen clock) | — | — |
| AS-62 static ownership check and foreign-key probe | `onboarding-boundaries.e2e-spec.ts` (catalog query); gate `check:table-ownership --strict` | — | — |
| AS-63 shop names through one R1 batch call | `onboarding-boundaries.e2e-spec.ts` (spy on the exported service) | — | — |
| AS-64 no open transaction during model, storage and queue calls | `onboarding-boundaries.e2e-spec.ts` (database activity view from the fake model) | — | — |
| AS-65 problem+json for every failure class, generic 500 | `onboarding-boundaries.e2e-spec.ts` (table over FR-100) | — | — |
| AS-66 metrics series and label set | `onboarding-boundaries.e2e-spec.ts` (in-memory metric reader) | — | — |
| AS-67 log correlation and absence of personal data | `onboarding-boundaries.e2e-spec.ts` (captured log stream, full run) | — | — |
| AS-68 every response parses with its contracts schema | `onboarding-boundaries.e2e-spec.ts` (route table check) | — | — |
| AS-69 configuration validation at startup | — | — | `domain/extraction-config.spec.ts` (`it.each` bad configurations) |
| AS-70 document and application status machines | — | — | `domain/status-machines.spec.ts` (`it.each` over every state × event) |
| AS-71 IBAN, VAT, name validators and masking | — | — | `domain/validators.spec.ts` (`it.each`; `fast-check` for mod-97) |
| AS-72 cross-step rule and required-document derivation | — | — | `domain/questionnaire.spec.ts` (`it.each`) |
