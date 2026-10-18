---
id: S04
title: Staged onboarding questionnaire, KYC document intake, LLM extraction, human review, shop verification
kind: capability
status: draft
generated_at: 4764563d
depends_on: [S03, S53, S46, S54, S50, S01]
concepts: [problem-json-errors, outbox-task-queue, tenant-shop-rbac, transaction-runner, rate-limit-policy, request-context, access-token-session, job-scheduler-lease, idempotency-key]
models: []
scope:
---
# S04 - Staged onboarding questionnaire, KYC document intake, LLM extraction, human review, shop verification

## Purpose
A new shop is not trusted with payouts until the platform knows who is behind it. This capability collects business answers in a four-step questionnaire and takes the business documents (company registration, bank statement, and VAT certificate for VAT-registered shops). An AI model reads the documents, hard rules check the result, and a human reviewer decides every doubtful case. When every required document is approved, the capability announces that the shop is verified.

## Entry points
The facts list no routes under "Routes and pages". The endpoints below come from the tested scenarios and are named without code-formatted routes because they are not confirmed as built routes.
- Seller questionnaire endpoints: save a step of a shop's onboarding, submit, and read the onboarding view. Seller needs `shop.manage` on the shop (see {{concept:tenant-shop-rbac}}).
- Seller document endpoints: request an upload grant, and confirm that the upload is done.
- Moderator review endpoints: list open review tasks, and resolve a task (approve, reject document, reject application). Only platform roles `ADMIN` and `MODERATOR` may call them.
- Queue message `onboarding.extract_document {documentId}` on the `onboarding-documents` queue: starts the model extraction of one document. [code: packages/backend/apps/lambdas/src/handlers/document-extractor.ts#handler]
- Event `shop.onboarding_submitted`, emitted on submit.
- Event `shop.onboarding_document_rejected`, emitted when a reviewer rejects a document.
- Event `shop.rejected`, emitted when a reviewer rejects the application.
- Event `shop.verified`, emitted once when the last required document is approved.
- Consumed event `tenancy.shop_deleted {shopId}`: deletes raw files and schedules erasure.
- Scheduled jobs: purge of raw files 30 days after verification or rejection of a round; erase of KYC records after `kycRecordRetentionDays`.

## Rules
- **S04.R-01** The [questionnaire](../terms/onboarding-questionnaire.md) has exactly four steps: `business`, `tax`, `catalog`, `policies`; a body with an unknown step name, an unknown field or a non-object is refused. [proof: S04 AS-02, S04 AS-72]
- **S04.R-02** Saving a step MUST NOT alter other steps; saving resets the [draft lifetime](../terms/onboarding-draft-lifetime.md) to 7 days; no [relational row](../terms/onboarding-row.md) exists before submission. [proof: S04 AS-03]
- **S04.R-03** [Submit](../terms/onboarding-submit.md) MUST answer [`400 validation_failed`](../terms/validation-failed-error.md) when a step is missing, when `vatRegistered` is true without `vatNumber`, when it is false with one, or when the VAT number does not fit the business country. [proof: S04 AS-04, S04 AS-72]
- **S04.R-04** [Required documents](../terms/required-onboarding-documents.md) are `BUSINESS_REGISTRATION` and `BANK_STATEMENT`, plus `VAT_CERTIFICATE` only when `vatRegistered` is true. [proof: S04 AS-05, S04 AS-72, S04 AS-13]
- **S04.R-05** Submit is [idempotent ↗](../sw-external-terms.md#idempotency): a repeated, racing or [post-consumption submit](../terms/post-consumption-submit.md) answers `200` with the same body and leaves one onboarding row and one [`shop.onboarding_submitted` event](../terms/shop-onboarding-submitted-event.md). [proof: S04 AS-06]
- **S04.R-06** Step saves answer [`409 already_submitted`](../terms/already-submitted.md) while the application is [`SUBMITTED`](../terms/onboarding-application-status.md) or `VERIFIED`, and create no [draft](../terms/onboarding-draft-lifetime.md). [proof: S04 AS-07]
- **S04.R-07** A caller without credentials gets [`401 invalid_token`](../terms/invalid-token-error.md); a [non-member](../terms/shop-membership.md), unknown or malformed shop ID gets the same [`404 shop_not_found`](../terms/shop-not-found.md). [proof: S04 AS-08, S04 AS-21]
- **S04.R-08** A document request is refused with [`409 submission_required`](../terms/submission-required.md) before submit, [`409 document_already_approved`](../terms/document-already-approved.md) for an approved [kind](../terms/document-kind.md), [`409 already_verified`](../terms/already-verified.md) when verified, and [`409 resubmission_required`](../terms/resubmission-required.md) when rejected. [proof: S04 AS-10, S04 AS-18]
- **S04.R-09** Allowed types and caps: PDF up to 10 MB; JPEG, PNG and WebP up to 5 MB; the [SHA-256 ↗](../sw-external-terms.md#sha-256) is 64 lowercase hex characters. [proof: S04 AS-12]
- **S04.R-10** A document is unique per shop, [round](../terms/document-round.md), kind and [content hash](../terms/document-content-hash.md); a repeated request answers `200` with [`deduplicated: true`](../terms/document-deduplicated-flag.md) and the same ID. [proof: S04 AS-14]
- **S04.R-11** A [kind](../terms/document-kind.md) MUST NOT have more than 5 distinct documents per [round](../terms/document-round.md); the sixth answers `[409 document_limit_reached](../terms/document-limit-reached.md)`. [proof: S04 AS-19]
- **S04.R-12** Upload requests (20 per hour) and [submissions](../terms/submission.md) (10 per day) are [limited per shop](../terms/rate-limit.md); excess answers `429` with [`Retry-After` ↗](../sw-external-terms.md#retry-after) and persists nothing. [proof: S04 AS-20]
- **S04.R-13** Confirming an upload moves the document to [`QUEUED`](../terms/document-status.md) and appends the [extraction message](../terms/extraction-message.md) to the [outbox](../terms/inbox-table.md) in the [same transaction](../terms/active-transaction.md). [proof: S04 AS-15]
- **S04.R-14** Confirming a new file of a kind [supersedes](../terms/document-supersede.md) older [unresolved](../terms/document-status.md) or rejected documents of that kind and cancels their open [review tasks](../terms/review-task.md). [proof: S04 AS-17, S04 AS-33]
- **S04.R-15** A document gets at most two model calls: the [cheap model](../terms/cheap-model.md) first, the [strong model](../terms/strong-model.md) once, only when an [issue](../terms/document-issue.md) is marked [escalating](../terms/escalating-issue.md). [proof: S04 AS-22, S04 AS-24, S04 AS-25]
- **S04.R-16** Rules decide acceptance, not [model confidence](../terms/model-confidence.md); a document with any issue MUST NOT be [auto-approved](../terms/auto-approval.md). [proof: S04 AS-23, S04 AS-26]
- **S04.R-17** A model answer that is not [strict JSON](../terms/strict-json.md) of the schema counts as [`invalid_output`](../terms/invalid-output.md), and nothing from it is stored as [accepted](../terms/document-status.md). [proof: S04 AS-27]
- **S04.R-18** The [real file type](../terms/real-file-type.md) is read from the bytes; a mismatch with the declared type or a [missing object](../terms/missing-object.md) [sends the document to review](../terms/document-review.md) without a model call. [proof: S04 AS-28, S04 AS-29, S04 AS-35]
- **S04.R-19** Extracted values are stored [masked](../terms/masked-value.md) and without [evidence](../terms/extraction-evidence.md) in a readable column, and in a [sealed copy](../terms/sealed-copy.md) bound to document and [attempt](../terms/job-attempt.md). [proof: S04 AS-30, S04 AS-67]
- **S04.R-20** Processing is [duplicate-safe ↗](../sw-external-terms.md#idempotency): one [worker](../terms/worker-instance.md) holds a [lease](../terms/job-lease.md) per document, and a completed attempt is never repeated. [proof: S04 AS-31]
- **S04.R-21** [Provider errors](../terms/provider-failure.md) (timeout, 429, 502, 503, 504) propagate so [the queue redelivers ↗](../sw-external-terms.md#at-least-once-delivery); no [attempt row](../terms/checkout-attempt.md) is written for them. [proof: S04 AS-32]
- **S04.R-22** A [malformed queue message](../terms/malformed-queue-message.md) is a [failed batch item](../terms/failed-batch-item.md) with no model call and no row change; other items continue. [proof: S04 AS-34] [code: packages/backend/apps/lambdas/src/handlers/document-extractor.ts#handler]
- **S04.R-23** Only [platform roles](../terms/platform-admin.md) `ADMIN` and `MODERATOR` use the review endpoints ([`403 insufficient_role`](../terms/insufficient-role.md) otherwise); a reviewer who is a [shop member](../terms/shop-member.md) gets [`403 conflict_of_interest`](../terms/conflict-of-interest.md). [proof: S04 AS-39, S04 AS-47]
- **S04.R-24** Human approval applies the same [hard checks](../terms/hard-checks.md) as extraction: [`422 iban_invalid`](../terms/iban-invalid.md), [`422 vat_invalid`](../terms/vat-invalid.md), or a missing [key field](../terms/key-field.md) refuses it. [proof: S04 AS-42, S04 AS-41]
- **S04.R-25** Resolving a task is a [conditional transition](../terms/durable-conditional-write.md): one resolver wins, a second gets [`409 task_already_resolved`](../terms/task-already-resolved.md), a [superseded document](../terms/superseded-document.md) gets [`409 document_superseded`](../terms/document-superseded.md). [proof: S04 AS-44, S04 AS-45]
- **S04.R-26** When the last [required kind](../terms/required-document-kind.md) is approved, the application becomes [`VERIFIED`](../terms/shop-verification.md) in the [same transaction ↗](../sw-external-terms.md#database-transaction), with exactly one [`shop.verified` event](../terms/shop-verified-event.md) and one [purge job](../terms/verification-document-purge-job.md). [proof: S04 AS-49, S04 AS-51, S04 AS-53]
- **S04.R-32** The local deployment (`local-monolith`) MUST consume `onboarding-documents` and its dead-letter queue itself with the same extraction service the Lambda uses, so that a document is decided without a separate Lambda runner; a deployed environment MUST NOT start that consumer. [proof: S04 G-11] [code: packages/backend/libs/domains/seller-onboarding/infra/local-document-extractor.ts#LocalDocumentExtractor]
- **S04.R-33** While an operator has paused `document-extractor` (the consumer control surface), a worker that receives an extraction message MUST NOT claim the document or call a model: it puts the message back with a delay of 2 s, so the document stays `QUEUED` and is decided within seconds of the resume. [proof: S04 G-10] [code: packages/backend/libs/domains/seller-onboarding/application/extractor-gate.ts#ExtractorGate]
- **S04.R-31** The job `onboarding.verify-pending` (run by an administrator through `POST /admin/jobs`) MUST evaluate every `SUBMITTED` application that has an approved document through the same verification policy, so a shop left with every required kind approved and no `shop.verified` (a crash between the approval and the verification) becomes `VERIFIED` with exactly one `shop.verified`; running it twice, or on a shop still waiting for a document, MUST change nothing. [proof: S04 G-09] [code: packages/backend/libs/domains/seller-onboarding/application/verify-pending.service.ts#VerifyPendingService]
- **S04.R-27** [Rejected operations](../terms/rejected-operation.md) [append no event](../terms/outbox-append.md), and a `VERIFIED` application is unchanged by [late results](../terms/late-result.md). [proof: S04 AS-52, S04 AS-54]
- **S04.R-28** The seller sees only `{id, kind, status, rejectionReason}` per document, and [`SUPERSEDED`](../terms/superseded-document.md) documents are hidden. [proof: S04 AS-55]
- **S04.R-29** No [database transaction ↗](../sw-external-terms.md#database-transaction) is open during a [model call](../terms/model-call.md), storage call or [queue publish ↗](../sw-external-terms.md#at-least-once-delivery). [proof: S04 AS-64]
- **S04.R-30** [The capability](../terms/capability.md) reads and writes only [its own tables](../terms/table-ownership.md); shop names come from [one batch call to tenancy](../terms/batch-shops-lookup.md). [proof: S04 AS-62, S04 AS-63] [code: packages/backend/db/ownership.ts#OWNERSHIP]

## Behaviors
- **S04.B-01** Given a [shop member](../terms/shop-member.md) with [`shop.manage`](../terms/permission.md), when they save the [`business` step](../terms/onboarding-step.md), then the view shows [`DRAFT`](../terms/onboarding-draft.md), the saved answers and missing steps `tax`, `catalog`, `policies`. [proof: S04 AS-01]
- **S04.B-02** Given [two simultaneous saves](../terms/optimistic-concurrency.md) of different steps, when both finish, then both are in the [draft](../terms/onboarding-draft.md). [proof: S04 AS-03]
- **S04.B-03** Given a [complete draft](../terms/onboarding-draft.md), when it is submitted, then the answer is `200 {submitted: true, [submissionNo](../terms/submission-no.md): 1, [requiredDocuments](../terms/required-documents.md)}`. [proof: S04 AS-05]
- **S04.B-04** Given a submitted shop, when the seller requests a [`BANK_STATEMENT`](../terms/onboarding-document-type.md) [upload](../terms/document-upload.md), then the answer is `201` with status [`AWAITING_UPLOAD`](../terms/document-status.md) and a [grant](../terms/upload-grant.md) valid for 15 minutes. [proof: S04 AS-11]
- **S04.B-05** Given a shop that is not [VAT registered](../terms/vat-registered.md), when a [`VAT_CERTIFICATE`](../terms/onboarding-document-type.md) is requested, then the answer is [`422 document_not_required`](../terms/document-not-required.md). [proof: S04 AS-13]
- **S04.B-06** Given an upload whose size differs from the [declared size](../terms/document-upload.md), when it is [confirmed](../terms/document-upload.md), then [`422 upload_mismatch`](../terms/upload-mismatch.md) is returned and the object is deleted. [proof: none]
- **S04.B-07** Given a [queued document](../terms/document-status.md) and a [cheap-model](../terms/cheap-model.md) answer that passes [every rule](../terms/document-validation-rule.md), when processed, then one call is made and the document is [`APPROVED`](../terms/document-status.md). [proof: S04 AS-22]
- **S04.B-08** Given a [low-confidence](../terms/model-confidence.md) [IBAN ↗](../sw-external-terms.md#iban) from the cheap model, when processed, then the [strong model](../terms/strong-model.md) is called and the document is `APPROVED` if its answer passes. [proof: S04 AS-24]
- **S04.B-09** Given both models produce an [escalating issue](../terms/escalating-issue.md), when processed, then the document is [`NEEDS_REVIEW`](../terms/document-status.md) with one open [review task](../terms/review-task.md). [proof: S04 AS-25]
- **S04.B-10** Given a bank statement whose text tells the model to [ignore instructions ↗](../sw-external-terms.md#prompt-injection) and whose [holder differs from the business name](../terms/holder-name-check.md), when processed, then one call is made and the document goes to [`NEEDS_REVIEW`](../terms/document-status.md). [proof: S04 AS-26]
- **S04.B-11** Given a document declared PDF whose bytes are a PNG, when processed, then no [model call](../terms/model-call.md) happens and [review](../terms/document-review.md) gets [`content_type_mismatch`](../terms/content-type-mismatch.md). [proof: S04 AS-29]
- **S04.B-12** Given a [model call](../terms/model-call.md) that times out, when processed, then the document stays [`EXTRACTING`](../terms/document-status.md) and the [redelivery](../terms/webhook-redelivery.md) completes it. [proof: S04 AS-32]
- **S04.B-13** Given 120 [open tasks](../terms/moderation-task.md), when a [moderator](../terms/moderator.md) lists with `limit=50`, then pages follow `createdAt, id` order without gaps until [`nextCursor: null`](../terms/pagination-cursor.md). [proof: S04 AS-37, S04 AS-38]
- **S04.B-14** Given a task with an invalid [IBAN ↗](../sw-external-terms.md#iban), when a [moderator](../terms/moderator.md) approves with a corrected IBAN, then the task stores [masked extracted and corrected values](../terms/masked-value.md) and the [sealed row](../terms/sealed-row.md) holds the correction. [proof: S04 AS-41]
- **S04.B-15** Given an open task, when a moderator rejects with a reason of 3 to 500 characters, then the document is [`REJECTED`](../terms/document-status.md), the seller sees the reason, and [`shop.onboarding_document_rejected`](../terms/shop-onboarding-document-rejected-event.md) is [appended](../terms/outbox-append.md). [proof: S04 AS-43]
- **S04.B-16** Given a [`SUBMITTED`](../terms/onboarding-application-status.md) application, when a moderator rejects the application with a [reason code](../terms/rejection-reason-code.md), then the [open tasks](../terms/moderation-task.md) are cancelled and [`shop.rejected`](../terms/shop-rejected-event.md) is published. [proof: S04 AS-46]
- **S04.B-17** Given only some [required kinds](../terms/required-document-kind.md) approved, when approvals occur, then the application stays [`SUBMITTED`](../terms/onboarding-application-status.md) and no event is published. [proof: S04 AS-50]
- **S04.B-18** Given a [`REJECTED`](../terms/onboarding-application-status.md) application, when the seller [saves a step](../terms/onboarding-step.md) and submits again, then [`submissionNo`](../terms/submission-no.md) is 2 and the application is `SUBMITTED`. [proof: S04 AS-56]
- **S04.B-19** Given a [verified application](../terms/shop-verification.md) 30 days old, when the [purge job](../terms/onboarding-document-purge-job.md) runs, then [raw files](../terms/raw-document-file.md) are deleted and [sealed and masked fields](../terms/sealed-row.md) remain. [proof: S04 AS-58]
- **S04.B-20** Given [`tenancy.shop_deleted`](../terms/shop-deleted-event.md), when consumed, then [raw files](../terms/raw-document-file.md) are deleted at once and [open tasks](../terms/moderation-task.md) are [`CANCELLED`](../terms/moderation-task-status.md). [proof: S04 AS-60]

## Lifecycles
No model file exists for this capability. The statuses below come from the scenarios.
- Application: `NOT_STARTED`, `DRAFT`, `SUBMITTED`, `VERIFIED`, `REJECTED`. The seller moves it to `SUBMITTED` by submitting. Document approval moves it to `VERIFIED`. A moderator moves it to `REJECTED`. [proof: S04 AS-09, S04 AS-70]
- Document: `AWAITING_UPLOAD`, `QUEUED`, `EXTRACTING`, `NEEDS_REVIEW`, `APPROVED`, `REJECTED`, `SUPERSEDED`. The seller confirms the upload, the extraction worker claims and decides, a moderator resolves reviews, and a newer file supersedes. [proof: S04 AS-70]
- Review task: open, `APPROVED`, `REJECTED`, `CANCELLED`.

## Owns
- Tables: `ShopOnboarding`, `ShopDocument`, `DocumentExtraction`, `ReviewTask`, `OnboardingStatusHistory`. [code: packages/backend/db/ownership.ts#OWNERSHIP]
- Queue: `onboarding-documents`, message `onboarding.extract_document`.
- Jobs: `onboarding.purge-documents`, `onboarding.erase-records`, `onboarding.verify-pending` (S04.R-31).
- Events: `shop.onboarding_submitted`, `shop.onboarding_document_rejected`, `shop.rejected`, `shop.verified`.
- Configuration: cheap-model and strong-model settings (must differ), queue visibility timeout (at least 6 times the 45 s model timeout), `kycRecordRetentionDays` (default 1825). [proof: S04 AS-69]

## Decisions
- Cheap model first, one escalation only: this limits cost and caps attempts at two.
- Rules decide, not model confidence: the document text is data and may carry injected instructions.
- Values are stored twice, masked and sealed, so logs, metrics and responses never hold sensitive values.
- The queue is the only retry layer, so provider errors propagate.
- Verification happens in the same transaction as the last approval, so racing approvals give exactly one `shop.verified`.
- This capability never writes shop verification or payout fields; tenancy derives them from events.
- Drafts live in a temporary store with a sliding 7-day lifetime, so no relational row exists before submission.

## Known gaps
- AS-16 (unconfirmed upload and size mismatch), AS-57 (round 2 de-duplication), AS-63 and others are present in the scenario list, but AS-16, AS-57 and AS-68 are not in the list of tests with scenario ids; rules citing AS-16 rely on AS-15 only in practice.
- AS-57 (same file in round 2, racing resubmissions) has no test carrying its id.
- AS-68 (all responses parse against the contract schemas) has no test carrying its id.
- No routes are listed in the facts, so the exact paths are unconfirmed in this page.
- The specification text for AS-02, AS-23, AS-26, AS-31 and others is cut off in the facts; their full detail is unverified here.
- The `extraction_unavailable` review after 5 receives (FR-026) has no scenario id with a test.
- Rule S04.R-15 to R-17 and R-19 depend on e2e tests whose content was not shown; only their ids were checked.

### Claims the generator could not verify (removed from the rules above)
- proof `S04 AS-16` (no test carries it)
