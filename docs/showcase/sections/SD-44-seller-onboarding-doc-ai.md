# SD-44 — Seller Onboarding: AI Document Processing (KYC) + Staged Questionnaire

Status: ☑ done (typechecked; specs written, not run) · Phase 7 · Depends on: SD-03, SD-42 (provider port), SD-02, F-02 · Also covers 10/02 Example 6 (staged questionnaire)

## Marketplace adaptation
New shops onboard by answering a multi-step **questionnaire** (business type, categories, returns policy) and uploading **business registration / VAT / bank documents**. An LLM extracts structured fields; low-confidence results go to a human review queue; approved → shop activated (payouts enabled).

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Questionnaire answers staged in **Redis hash** (TTL refreshed) → submit validates completeness → one transaction writes answers + outbox | 10/02 Ex6 |
| Document pipeline: S3 + `RECEIVED` → SQS → text extraction → **LLM extraction with JSON schema (tool use)** → **zod validation** + business rules (VAT checksum, IBAN mod-97) → confidence checks | 10/10 #44 |
| Idempotency by document content hash | 10/10 #44 |
| Cheap model first (Haiku), escalate to stronger on validation failure; cache by hash | 10/10 #44 |
| **Human-in-the-loop** review queue (corrections stored as eval data; correction rate per field metric) | 10/10 #44 |
| Prompt-injection safety: extraction step has **no tools that act**; output treated as untrusted data | 10/10 #44 |
| Retries with backoff for provider errors, DLQ + alarm for poison docs, partial batch failures | 06/01 §3 |
| PII: encrypted fields (bank account), retention policy job deleting raw docs after approval + N days | 05/02 §9 |

## Steps
- [x] `OnboardingSession` (Redis staging) + submit; `ShopDocument`, `DocumentExtraction` (per attempt), `ReviewTask` tables.
- [x] Lambda `document-extractor` (Nest cached context per Q6), schema + validators (IBAN/VAT pure, unit-tested).
- [x] Review endpoints (admin/moderator role).
- [x] e2e (scripted LLM): valid doc → fields extracted → shop VERIFIED; invalid IBAN from LLM → review task; same file twice → one extraction.

## Scale
- Target: 50k onboarding docs/day, bursts after marketing campaigns 50/s → limited by provider tokens/min → SQS buffer + concurrency cap matched to rate limit.

## Implementation notes (2026-10-02)
- **Where:** `libs/common/src/onboarding/`.
  - `OnboardingModule` (questionnaire, uploads, review queue) runs in core.
  - `OnboardingExtractionModule` runs in Lambda `document-extractor` (queue `onboarding-documents`, batch 2, maxConcurrency 20 = the LLM tokens/min budget, visibility 720 s = 6 × timeout, DLQ after 5).
  - `OnboardingWorkerModule` (retention job) runs in the worker.
- **Staged questionnaire** (10/02 Ex6):
  - Four steps, each with its own zod schema. Drafts go into a Redis hash (one field per step) with a 7-day sliding TTL, so abandoned drafts clean themselves up.
  - Submit re-validates the whole set, including cross-step rules (VAT registered ⇒ VAT number). It then writes `ShopOnboarding` + Shop `PENDING` + the `shop.onboarding_submitted` outbox event in one transaction, and drops the draft after commit.
  - Submit is idempotent. Required documents are derived from the answers.
- **Uploads:** presigned PUT pinned to SHA-256 and size; PDF/JPEG/PNG/WebP with per-type caps. Allowed only after submit, because extraction cross-checks the answers.
  - **Dedupe:** the same file for the same kind is the same row (unique hash), so it is never extracted or billed twice.
  - **Replacement:** a new upload supersedes unresolved or rejected ones of that kind; their review tasks drop out of the queue and resolving them is a 409.
- **Extraction** (`extraction.service.ts`):
  - **Request:** the document goes to Claude as a base64 `document` (PDF) or `image` block, with **structured outputs** (strict JSON schema: `documentType`, `legible`, and per field `{value, confidence, evidence}`). No tools; the prompt declares the document as data.
  - **Validation:** zod re-validates the output, then business rules decide:
    - IBAN mod-97 + country length; VAT format for every EU country, with checksums for DE (ISO 7064 MOD 11,10), PL and NL.
    - Legal name / account holder fuzzy-matched to the questionnaire (accents and legal suffixes ignored).
    - Registration number and country cross-checked; statement ≤ 180 days old.
    - Wrong document type, illegible, or a missing / low-confidence field.
  - **Escalation:** issues a better reader could fix (checksums, low confidence, misread numbers, wrong type) get ONE re-read by the strong model. Issues it can't fix (name or country mismatch, illegible, old statement, wrong bytes for the declared type, refusal) go straight to review.
  - **Records:** every attempt is a `DocumentExtraction` row with a masked view (IBAN `DE89 •••• 3000`, evidence dropped) and the full values sealed with AES-GCM (`SecretBox`).
  - **Redelivery** resumes after the last attempt instead of paying for attempt 1 again. Provider errors propagate (SQS retry → DLQ); everything else ends in APPROVED or NEEDS_REVIEW.
- **Verification:** `maybeVerify` locks the onboarding row. Once every required kind is APPROVED: Shop `VERIFIED`, `payoutsEnabled`, `shop.verified` outbox event, and a purge job 30 days later. The job deletes raw files and keeps the sealed fields.
- **Review queue** (ADMIN/MODERATOR):
  - **Queue view:** masked fields, the stop reasons, and a 5-minute presigned link to the file.
  - **Approve:** takes corrections, but the hard checks still apply (an invalid IBAN is 422 even for a human). The final values become a `model = 'human'` extraction row.
  - **Corrections:** stored as masked `{extracted, corrected}` pairs, the labelled data for the extraction eval set, and counted per field (`kyc_field_corrections_total`). Outcomes are counted in `kyc_extraction_outcomes_total`.

## Test plan
| Scenario | API e2e (`onboarding.e2e-spec.ts`) | UI journey (web) | Unit |
|---|---|---|---|
| Steps validate alone; draft in Redis with TTL; cross-step rule on submit; idempotent submit; no edits after | "questionnaire: …" | web (seller): fill the 4 steps, submit (happy path) | — |
| Upload before questionnaire → 409 | "documents can only be uploaded after…" | — | — |
| Valid docs → APPROVED → shop VERIFIED, payouts on, purge scheduled | "happy path…" | web (seller): upload registration + bank statement, see "Verified" (happy path) | `validators.spec.ts` |
| IBAN masked, full values only sealed | "PII…" | — | — |
| Low-confidence read fixed by escalation | "a misread fixed by escalation…" | — | — |
| Bad IBAN → review; human can't approve invalid; correction recorded; shop verifies | "IBAN failing mod-97…" | web (moderator): open queue, correct IBAN, approve (happy path) | `validators.spec.ts` |
| Prompt-injected doc can't verify a shop (name mismatch → human) | "prompt-injected document…" | — | — |
| Same file twice → one document; redelivery → one model call | "idempotency…" | — | — |
| Declared type ≠ bytes → review, no model call | "declared PDF but the bytes are a PNG…" | — | — |
| Newer upload supersedes; stale task refused | "a newer upload supersedes…" | — | — |
| Role checks; sellers see statuses only | "only moderators/admins…" | — | — |
| Retention purge deletes files, keeps sealed fields | "retention…" | — | — |
