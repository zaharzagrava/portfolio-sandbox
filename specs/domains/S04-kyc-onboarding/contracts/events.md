# Event and message contracts: S04

Produced through the outbox in the same transaction as the state change. Topic `shops.events` (aggregate type `shops`), key `shopId`, envelope `{eventId, type, version, occurredAt, aggregateId: shopId}`. `defineEvent` lives in `SO/application/events/onboarding-events.ts` (the only registration; tenancy must not re-register). `shopId` is validated as a UUID.

| Type | v | Payload | Emitted by | Consumers |
|---|---|---|---|---|
| `shop.onboarding_submitted` | 1 | `{shopId, submissionNo, country, legalForm, requiredDocuments}` | submit (round 1 and resubmission) | S03 (`→PENDING`) |
| `shop.verified` | 1 | `{shopId, submissionNo, verifiedAt}` | verification inside the last approving transaction | S03 (`→VERIFIED`, payouts), S28 |
| `shop.rejected` | 1 | `{shopId, submissionNo, rejectedAt, reasonCode}` | reviewer `REJECT_APPLICATION` only | S03 (`→REJECTED`), S28 |
| `shop.onboarding_document_rejected` | 1 | `{shopId, documentId, kind, reason}` | reviewer `REJECT` | S28 |

Free-text application rejection reason never leaves the domain. Additive fields only in later versions.

**Topic unchanged** (aggregate/topic `shops`, `shops.events`): tenancy already reads it. S28's constant `shop-onboarding` is the stale one: see `gaps.md` → Sibling-spec follow-ups. The contract version of `shop.verified` stays `1` (tenancy matches only v1; the `2` in `ShopVerified.create` was the aggregate-version argument, A27).

## Single-consumer message

`onboarding.extract_document` v1 `{documentId: uuid}` → queue `onboarding-documents` (standard queue, no `groupId`, DLQ after 5 receives, visibility ≥ 6 × 45 s = 270 s). Appended by `OutboxService.appendTask` in the confirming transaction. Consumer: Lambda `document-extractor` (partial batch failures; invalid body ⇒ failed item, no side effect). Dead-letter handler: `document-extractor-dlq` → `ExtractionService.routeToReview(documentId, 'extraction_unavailable')`.

## Consumed

`tenancy.shop_deleted` v1 `{shopId}` (S03) through the S53 inbox (dedupe by `eventId`; strict payload; invalid ⇒ DLQ, no effect).

## Jobs (S49)

`onboarding.purge-documents {shopId, submissionNo}`, `onboarding.erase-records {shopId}` (single-run, idempotent; keys in data-model.md).

## LLM metering

Each model call → `LlmCallRecorder` (`llm.call_completed` v1) with `{subjectId: shopId, scopeId: documentId, callId: "<documentId>:<attempt>", purpose: "extraction"}`; S04 owns no billing event.
