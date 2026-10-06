# Open Decisions for S04 (answered unattended)

Format: `[TAG] question → default taken → why`. BREAKING first, then CONTRACT, then LOCAL. The human reviews BREAKING and CONTRACT lines first. Decision policy: most production-grade option the Interview-Prep notes and the constitution support.

## BREAKING (changes behaviour or an API/UI contract that exists today)

- [BREAKING] Who writes the shop's verification status and payout flag (today `onboarding-session.service.ts` and `verification.service.ts` run `UPDATE "Shop"`, the review queue runs `JOIN "Shop"`) → S04 writes no `Shop` column and never reads the table; tenancy derives `PENDING/VERIFIED/REJECTED` and `payoutsEnabled` from our events; queue shop names come from R1 `getShopsByIds` → IX.4 (D-7/D-12); S03 FR-008 and AS-71/72 already expect it.
- [BREAKING] Verification and approval commit separately today (`maybeVerify` runs after the approving transaction in `review.service.ts` and `extraction.service.ts`; a crash between them leaves every document `APPROVED` and the shop unverified) → the verification decision runs inside the approving transaction, serialized per shop → III.6 (invariant in the store), no repair job needed.
- [BREAKING] The extraction queue message is sent after commit (`queue.enqueue` in `onboarding-documents.service.ts`; a crash after commit strands a `QUEUED` document) → the message is appended to the outbox in the confirming transaction → IV.4, III.3.
- [BREAKING] Extraction claim (today any worker may claim `QUEUED` or `EXTRACTING`, so two concurrent deliveries both call the model; `finish` creates a review task even when the document was superseded) → a 5-minute lease, a conditional finish that asserts one row and discards results for a superseded document → III.6/III.7, cost control (design 44 "idempotency").
- [BREAKING] Messages parked in the DLQ leave documents in `EXTRACTING` forever → a dead-letter handler routes them to human review with `extraction_unavailable` and raises the alarm metric → design 44 "DLQ + alarm for poison documents" and "no document is lost".
- [BREAKING] Model output validation (today unknown keys are silently stripped by zod) → strict: extra keys, over-long values or bad confidence are `invalid_output` (escalate once, then review) → untrusted-output rule, prompt injection (notes 10/10 #44).
- [BREAKING] Questionnaire validation (today the step body is `unknown`, parsed by hand, unknown fields stripped, errors are one joined string, an unknown step name passes the type system) → strict per-step schemas, `400 validation_failed` with `errors: [{path, message}]` including for the step name → P0112, V.3.
- [BREAKING] Cross-step rules (today only "VAT registered ⇒ number") → also "VAT number ⇒ registered" and "number valid for the business country" at submit → fails early instead of costing a document and a review.
- [BREAKING] Document request rules (today any kind, any time after submit, unique `(shop, kind, hash)`, always `201`) → only required kinds (`422 document_not_required`), only while `SUBMITTED`, no new document for an approved kind, ≤ 5 per kind per round, uniqueness per `(shop, round, kind, hash)`, `201` for new and `200` for de-duplicated → stops model-cost abuse and wasted extraction; needed for resubmission.
- [BREAKING] Response shapes: submit gains `submissionNo`; `GET /shops/:id/onboarding` gains `status`, `submissionNo`, returns submitted answers after submission (today `answers: {}` after the draft is consumed) and `requiredDocuments` as `{kind, status}[]`; review queue becomes `{items, nextCursor}` with `attempts` (today a bare array capped by `limit`) → keyset pagination (III.10), a UI that can show progress.
- [BREAKING] Review resolve semantics (today `reason` optional on reject with a default text, unknown correction fields ignored, stale task `409`, resolved task `404`, no application-level rejection) → reason 3–500 characters required, unknown or over-long corrections `400`, resolved task `409 task_already_resolved`, unknown `404 review_task_not_found`, key fields required for approval (`422 missing_fields`), new `REJECT_APPLICATION` decision → precise status codes (V.4), completes the state machine S03 expects (`REJECTED`).
- [BREAKING] Review endpoints (today `Firewall({roles})` only) → `sensitive: true` (revoked sessions refused immediately) and a conflict-of-interest refusal for reviewers who are members of the shop → access to PII and approval authority are the highest-risk actions of the domain; four-eyes principle.
- [BREAKING] Event topic and payloads (today aggregate/topic `shops`, payload `{shopId, country, legalForm, requiredDocuments}` and `{shopId, verifiedAt}`) → topic `shop-onboarding`; every payload gains `submissionNo`; new `shop.rejected` and `shop.onboarding_document_rejected` → I.4 (one producer per topic; tenancy owns the `tenancy.*` stream), ordering across resubmission rounds.
- [BREAKING] Retention (today one purge job per shop, scheduled only on verification, payload `{shopId}`) → payload `{shopId, submissionNo}`, also scheduled 30 days after `shop.rejected`, plus the `tenancy.shop_deleted` consumer and an erase job at 1825 days → design 44 PII retention; S03 expects every shop-owning domain to purge on `shop_deleted`.
- [BREAKING] Sealed values (today `SecretBox.seal(json)` with no context) → sealed with context `kyc:<documentId>:<attempt>`; opening accepts legacy values → ciphertext cannot be swapped between rows (S01 FR on `SecretBox` context).
- [BREAKING] Foreign keys (`ShopOnboarding.shopId` and `ShopDocument.shopId` reference `Shop`) → dropped by an expand/contract migration; IDs stay as plain columns → IX.4.3.
- [BREAKING] Ownership of the `Shop.verificationStatus` / `payoutsEnabled` columns (added by this domain's migration `20261002170000-seller-onboarding.js`) → belong to tenancy's schema (S03 Key Entities); this domain's migration history stays, tenancy's migration is the authority going forward → IX.3.
- [BREAKING] Rate limits and error codes (none today) → `onboarding.upload.shop` 20/h, `onboarding.submit.shop` 10/day; stable codes of FR-100 → V.3, abuse and cost control.
- [BREAKING] LLM access and metering (today `ExtractionModule` imports assistant's `LlmModule`, `LlmMeter`, billing's `UsageService`, ClickHouse and Kafka producer modules) → only the LLM port, metering by the port's `llm.call_completed` event (S46); config validated at startup → X.3, D-14, IV.5 and IV.6 (45 s timeout, queue as the single retry layer).
- [BREAKING] Metric names (`kyc_*` today: three counters) → add duration, tokens, failures and queue-age series; no identifiers as labels → design 44 "per-stage success rates, queue age, cost per document".

## CONTRACT (decides something another capability must provide or consume)

- [CONTRACT] `shop.rejected` trigger → emitted only on the reviewer's `REJECT_APPLICATION`; a rejected document alone is not a rejection (the seller re-uploads) → S03 AS-71 needs `PENDING→REJECTED`; S03's own question said "if S04 does not emit it, REJECTED is unreachable".
- [CONTRACT] Resubmission after rejection → allowed (round `submissionNo + 1`), emits `shop.onboarding_submitted` again → S03 AS-71 includes `REJECTED→PENDING`.
- [CONTRACT] Event fields beyond `{shopId}` → `submissionNo`, `country`, `legalForm`, `requiredDocuments`, `verifiedAt`, `rejectedAt`, `reasonCode` (free-text reason never leaves this domain) → S03 asked only for `{shopId}`; additive changes are safe.
- [CONTRACT] Permission for onboarding routes → `ShopScoped('shop.manage')` (OWNER and ADMIN per S03 FR-020); staff and viewers get `403` → they must not change KYC answers; no new permission needed.
- [CONTRACT] Conflict-of-interest check → needs S03 `ShopAccessService.getRole(shopId, userId)` (already in S03's Provides) → the only R1 call besides `getShopsByIds`.
- [CONTRACT] Shop names in the queue → S03 `ShopQueryService.getShopsByIds` (≤ 500 IDs per call; we send ≤ 100) → replaces `JOIN "Shop"`.
- [CONTRACT] `tenancy.shop_deleted` v1 `{shopId}` → consumed here (purge raw files now, erase records after 1825 days) → S03 says every shop-owning domain purges on it.
- [CONTRACT] S01 `SecretBox.seal/open(value, context)` and `open` accepting legacy no-context values → S01's questions already state the optional `context` and the fallback; S04 adopts the context `kyc:<documentId>:<attempt>`.
- [CONTRACT] S01 platform roles `ADMIN` and `MODERATOR` and `Firewall({roles, sensitive})` → used as-is; `MODERATOR` exists today.
- [CONTRACT] S46/infrastructure LLM port shape (`complete({model, system, messages, tools, outputSchema, maxTokens, timeoutMs})`, document and image blocks, strict structured output, typed transient error, no internal retry for this use, metering by `llm.call_completed`) → S46's spec does not exist yet; this is what S04 needs and what exists today in `assistant/infra/llm`.
- [CONTRACT] S53 outbox must publish a single-consumer command to SQS (`onboarding.extract_document`), not only Kafka events → IV.3 (single-consumer tasks go to SQS), IV.4 (no dual write).
- [CONTRACT] S55 DLQ for `onboarding-documents` (max receives 5, visibility ≥ 6 × 45 s) with a dead-letter handler calling `ExtractionService.routeToReview` → today only the manifest's queue settings exist; the handler is new.
- [CONTRACT] S50 policy names `onboarding.upload.shop` and `onboarding.submit.shop` → declared in S50's registry.
- [CONTRACT] No export of sealed values (IBAN) to payouts → S15's spec must request an R1 export if it needs them; nothing exposes plain bank details now → least exposure of PII.
- [CONTRACT] UI journeys → the seller wizard and moderator console belong to web capabilities not yet specified (`specs/web` is empty); `test-plan.md` names the Playwright file `packages/web/tests/seller-onboarding.spec.ts` for whoever builds the screens.

## LOCAL (this capability's internals)

- [LOCAL] Draft store → keep the temporary hash with 7-day sliding TTL (notes 10/02 Ex6); losing it only costs re-entry.
- [LOCAL] "Cache results by document hash" → per shop and round only; no cross-tenant reuse of extracted values.
- [LOCAL] Review claim/assignment → not built; single-winner resolve is enough.
- [LOCAL] `ReviewTask` gains status `CANCELLED` (superseded, application rejected, shop deleted).
- [LOCAL] Status history table for applications and documents → added (III.7).
- [LOCAL] Escalation rules and issue codes → unchanged from today's `evaluate`, now a pure domain function with an injected clock.
- [LOCAL] Name match threshold 0.6, statement age 180 days, model timeout 45 s, lease 5 min, attempts 2, link 300 s, grant 15 min → today's values or notes-derived defaults, as configuration.
- [LOCAL] Record retention after shop deletion → 1825 days (typical AML record period); configurable.
- [LOCAL] Prompt version → still stored per attempt; bumped with any prompt or schema change.
- [LOCAL] Sniffing and `evaluate` move to `domain/`; `ExtractionService` and the Lambda keep their entry names.
