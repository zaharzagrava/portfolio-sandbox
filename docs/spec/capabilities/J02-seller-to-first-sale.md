---
id: J02
title: New seller registers, creates a shop, passes onboarding/KYC, subscribes to a plan, lists a product that becomes searchable, sells it, receives the order webhook, and appears on the leaderboard
kind: capability
status: draft
generated_at: 88532710
depends_on: [S01, S03, S04, S05, S10, S13, S17, S32, S40, S43, S53, J01]
concepts: [idempotency-key, outbox-task-queue, projection-and-replay, tenant-shop-rbac, search-index, order-reservation, payment-lifecycle, access-token-session, problem-json-errors]
models: []
scope:
---
# J02 - New seller to first sale
## Purpose
A new seller signs up, opens a shop, passes onboarding and KYC, pays for a plan, lists one product, sells it, and the shop's systems receive the order webhook. The shop then appears on the public leaderboard. This journey proves only the hand-offs between the eleven domains that take part; each domain's internal rules belong to that domain's own page.

## Entry points
The facts list no routes or pages for this capability. The journey drives other capabilities through their public APIs, the webhook receiver `R` and the test control surface.
- Journey test `seller-to-first-sale.journey-spec.ts`: runs scenarios AS-01 to AS-33 against the local stack.
- Local queue configuration `infra/docker/elasticmq/elasticmq.conf`: the only code file listed for this capability. It configures the local SQS-compatible queue that carries document-extraction commands.

## Rules
- **J02.R-01** Registration MUST NOT issue [tokens](../terms/access-token.md); sign-in is a separate call that returns [`user.role: "USER"`](../terms/platform-role.md) for a new account. [proof: J02 AS-01]
- **J02.R-02** Creating a shop MUST write the shop and the [owner membership](../terms/shop-membership.md) and append [`tenancy.shop_created`](../terms/shop-created-event.md) and [`tenancy.member_added`](../terms/tenancy-shop-events.md) in one [transaction ↗](../sw-external-terms.md#database-transaction). [proof: J02 AS-01]
- **J02.R-03** [Identity](../terms/identity-domain.md) MUST promote `USER` to [`SELLER`](../terms/platform-role.md) only from the `[tenancy](../terms/tenancy-domain-layer.md).shop_created` event, conditionally and [idempotently ↗](../sw-external-terms.md#idempotency); tenancy MUST NOT write the role. [proof: J02 AS-02, J02 AS-05]
- **J02.R-04** If the [promotion consumer](../terms/event-consumer.md) is paused, the role MUST stay `USER`, the [consumer lag](../terms/ledger-lag-metric.md) MUST show at least 1, and the shop MUST still work for its owner. [proof: J02 AS-05]
- **J02.R-05** A request with the same {{concept:idempotency-key}} MUST return the same shop id with `201` and leave one shop and one [`OWNER` membership](../terms/shop-role.md). [proof: J02 AS-03]
- **J02.R-06** A user who is not a member of a shop MUST receive [`404 shop_not_found`](../terms/shop-not-found.md) for the shop and its [onboarding](../terms/onboarding-step.md), [identical to an unknown id](../terms/identical-not-found.md). [proof: J02 AS-04]
- **J02.R-07** Onboarding MUST announce decisions only through [`shop.onboarding_submitted`](../terms/shop-onboarding-submitted-event.md), [`shop.verified`](../terms/shop-verified-event.md) and [`shop.rejected`](../terms/shop-rejected-event.md); tenancy derives [`verificationStatus`](../terms/shop-verification.md) and [`payoutsEnabled`](../terms/payouts-enabled.md) from them. [proof: J02 AS-06, J02 AS-08, J02 AS-09]
- **J02.R-08** A [rejected application](../terms/onboarding-application-status.md) MUST leave the shop with `verificationStatus: "REJECTED"` and `payoutsEnabled: false`. [proof: J02 AS-08]
- **J02.R-09** A crash between "all documents approved" and "shop verified" MUST be repaired by the [sweep job](../terms/shard-sweep.md) [`onboarding.verify-pending`](../terms/onboarding-verify-pending-job.md), which appends `shop.verified` once. [proof: J02 AS-11]
- **J02.R-10** Subscribing MUST create the subscription, the first invoice and the [charge job](../terms/job.md) in one transaction, and the response MUST NOT contain the [payment method reference](../terms/payment-method-token.md). [proof: J02 AS-12, J02 AS-13]
- **J02.R-11** Paid [entitlements](../terms/entitlement.md) MUST be granted only after the first charge succeeds; a declined first charge MUST keep the [free tier](../terms/free-tier.md) and append [`billing.invoice_payment_failed`](../terms/billing-invoice-payment-failed-event.md). [proof: J02 AS-12, J02 AS-14]
- **J02.R-12** Creating a product beyond the free-tier limit [`maxProducts`](../terms/max-products.md) MUST answer [`409 plan_limit_reached {key, limit}`](../terms/plan-limit.md) and write nothing. [proof: J02 AS-17]
- **J02.R-13** Search MUST be built only from [catalog events](../terms/catalog-product-events.md) and MUST hide products of shops that are not [active](../terms/shop-status.md). [proof: J02 AS-18, J02 AS-22, J02 AS-23]
- **J02.R-14** [Consumers](../terms/event-consumer.md) MUST discard an event whose [version](../terms/aggregate-version.md) is lower than the version already applied, so edits, archive and restore reach search in order. [proof: J02 AS-09, J02 AS-16, J02 AS-21]
- **J02.R-15** Every consumer MUST be [idempotent ↗](../sw-external-terms.md#idempotency): [replaying](../terms/event-replay.md) [`orders.events`](../terms/orders-events-topic.md), [`products.events`](../terms/products-events-topic.md) or [`billing.events`](../terms/billing-events-topic.md) from the start MUST NOT change entitlements, plan, [rank](../terms/shop-rank.md), revenue, stock or search. [proof: J02 AS-16, J02 AS-29]
- **J02.R-16** A consumer that is down MUST lose no [fact](../terms/fact.md): after it resumes, every fact is applied once and its [lag](../terms/consumer-lag.md) is visible. [proof: J02 AS-05, J02 AS-15, J02 AS-20, J02 AS-28]
- **J02.R-17** A paid order MUST produce one [signed](../terms/webhook-signature-signing.md) [`order.paid`](../terms/order-paid-event.md) event per (order, shop), carrying only that shop's lines. [proof: J02 AS-25, J02 AS-26]
- **J02.R-18** A cancelled, declined or expired order MUST NOT create a [webhook](../terms/shop-webhook.md), a rank or a [board entry](../terms/leaderboard.md). [proof: J02 AS-31]
- **J02.R-19** The [leaderboard](../terms/leaderboard.md) MUST show the shop's current name from [tenancy events](../terms/tenancy-shop-events.md), and a rename MUST keep the [rank](../terms/shop-rank.md). [proof: J02 AS-30]
- **J02.R-20** Events, logs and webhook bodies MUST NOT carry document content, [payment method references](../terms/payment-method-token.md) or [webhook secrets](../terms/webhook-secret.md). [proof: none]

## Behaviors
- **J02.B-01** Given a new e-mail, when the visitor registers (`202`), logs in (`200`, role `USER`) and creates a [shop](../terms/shop-tenant.md), then the shop and [owner membership](../terms/shop-membership.md) exist. [proof: J02 AS-01]
- **J02.B-02** Given a created shop, when the [identity consumer](../terms/event-consumer.md) applies [`tenancy.shop_created`](../terms/shop-created-event.md), then `GET /auth/me` shows [`SELLER`](../terms/platform-role.md) and the next [refreshed token](../terms/token-refresh.md) carries `SELLER`. [proof: J02 AS-02]
- **J02.B-03** Given five concurrent shop creations with [one key](../terms/idempotency-key.md), then every answer is `201` with the same shop id and [`GET /shops/mine`](../terms/get-shops-mine.md) lists one shop. [proof: J02 AS-03]
- **J02.B-04** Given the four [questionnaire steps](../terms/onboarding-questionnaire.md) are saved, when the owner submits, then the answer is `200 {submitted: true, submissionNo: 1, requiredDocuments}` and documents are [extracted](../terms/extraction-attempt.md) and [approved automatically](../terms/auto-approval.md). [proof: J02 AS-06]
- **J02.B-05** Given a document the [extractor](../terms/extraction-worker.md) [routes to review](../terms/document-review.md), when an admin resolves the [task](../terms/moderation-task.md), then the admin list shows the task with `shopName`. [proof: J02 AS-07]
- **J02.B-06** Given a forged document, when an admin resolves the task with [`REJECT_APPLICATION`](../terms/moderation-task.md), then the shop is [`REJECTED`](../terms/shop-verification.md) with [payouts disabled](../terms/payouts-enabled.md). [proof: J02 AS-08]
- **J02.B-07** Given the extractor is stopped, when the seller [marks documents uploaded](../terms/document-upload.md), then documents stay [`QUEUED`](../terms/document-status.md), onboarding stays [`SUBMITTED`](../terms/onboarding-application-status.md) and the application is kept until the extractor returns. [proof: J02 AS-10]
- **J02.B-08** Given a [verified shop](../terms/shop-verification.md), when the owner subscribes with [`pm_test_visa`](../terms/payment-method-token.md), then the [charge job](../terms/job.md) pays the invoice and [entitlements](../terms/plan-limit.md) rise above the [free tier](../terms/plan-limit.md). [proof: J02 AS-12]
- **J02.B-09** Given a [declined first charge](../terms/definite-decline.md) with [`pm_test_declined`](../terms/payment-method-token.md), then the invoice stays unpaid and the shop keeps the [free tier](../terms/plan-limit.md). [proof: J02 AS-14]
- **J02.B-10** Given the [entitlements consumer](../terms/event-consumer.md) is [paused](../terms/partition-pause.md), when a shop subscribes and pays, then the invoice is `PAID` but entitlements stay on the [free tier](../terms/plan-limit.md) until the consumer resumes. [proof: J02 AS-15]
- **J02.B-11** Given an [active plan](../terms/plan-limit.md), when the owner creates a product with an [`Idempotency-Key`](../terms/idempotency-key.md), then the product becomes [searchable](../terms/search-visibility.md) and [`product.created`](../terms/product-created-event.md) reaches [the shop's endpoint](../terms/webhook-endpoint.md). [proof: J02 AS-18, J02 AS-19]
- **J02.B-12** Given the [search consumer](../terms/event-consumer.md) is [paused](../terms/partition-pause.md), when a product is created, then [`GET /products/P2`](../terms/get-product-by-id.md) answers `200` but search omits it until the consumer resumes. [proof: J02 AS-20]
- **J02.B-13** Given an admin [suspends](../terms/shop-status.md) a shop, then its products [leave search](../terms/search-visibility.md) and checkout is refused; [reinstating](../terms/shop-status.md) the shop restores them. [proof: J02 AS-22]
- **J02.B-14** Given a [webhook endpoint](../terms/webhook-endpoint.md) for the shop, when the owner creates it, then [the secret](../terms/webhook-secret.md) is shown once and later reads never return it. [proof: J02 AS-24]
- **J02.B-15** Given a buyer pays an order for the shop's product, then the shop receives [`order.paid`](../terms/order-paid-event.md), stock drops and the shop appears on the [leaderboard](../terms/shop-leaderboard.md). [proof: J02 AS-25]
- **J02.B-16** Given an order with products from two shops, when it is paid, then each shop receives [only its own lines](../terms/shop-subtotal.md) and is [ranked on its own revenue](../terms/shop-leaderboard.md). [proof: J02 AS-26]
- **J02.B-17** Given the receiver answers `500`, when an order is paid, then the first attempt fails and the [retry job](../terms/job-retries.md) delivers it later [without a duplicate effect ↗](../sw-external-terms.md#idempotency). [proof: J02 AS-27]
- **J02.B-18** Given the [webhook router](../terms/notification-router.md) is paused, when an order is paid, then the receiver gets nothing until the router resumes and then gets [exactly one `order.paid`](../terms/order-paid-event.md). [proof: J02 AS-28]
- **J02.B-19** Given a [declined](../terms/definite-decline.md) or expired order, then no `order.paid` is sent, [rank revenue](../terms/shop-leaderboard.md) is unchanged and [the stock is restored](../terms/stock-release.md) in search. [proof: J02 AS-31]

## Lifecycles
The journey owns no status. It observes statuses owned elsewhere: shop `verificationStatus` (including `REJECTED`), onboarding `SUBMITTED`, document `QUEUED` and `NEEDS_REVIEW`, and invoice `PAID`. No model is listed in the facts.

## Owns
- No tables, queues, topics or events. The journey reads events of other capabilities: `tenancy.shop_created`, `tenancy.member_added`, `shop.onboarding_submitted`, `shop.verified`, `shop.rejected`, `billing.invoice_paid`, `billing.invoice_payment_failed`, `catalog.product_*`, `order.paid`.
- Configuration: `infra/docker/elasticmq/elasticmq.conf` (local queue), the local provider doubles, the admin bootstrap and the receiver allow-list.

## Decisions
- The journey tests only the hand-offs between domains; rules inside one domain stay with that domain's own spec.
- Roles follow the shop by event, not by a direct write: only identity writes `User` and only tenancy writes `Shop`.
- Decisions travel as events appended in the deciding transaction, so a crash cannot lose them (FR-002, FR-004).
- A scheduled sweep repairs the gap between approval and verification.
- Every consumer is idempotent and version-guarded, so a replay or an out-of-order event changes nothing.
- Subscribing makes no provider call in the request; a charge job does it.

## Known gaps
- No test proves that events, logs and webhook bodies carry no document content, payment references or secrets (FR-026); R-20 has `[proof: none]`.
- AS-09 to AS-11, AS-27 and AS-29 have scenario ids in the test file, but the facts give no code excerpt to confirm assertion detail beyond the scenario text.
- AS-32 (metrics counters for every hop) and AS-33 (static gates) are P3 stories; this page states no rule for them.
- The facts list no routes, so entry points name no HTTP route as built by this capability.
- Hop time limits (FR-021) and ownership of the local-stack processes (FR-022 to FR-024) have no rule here and no named proof.
- Access control by role (`403`) in FR-025 is covered only for the `404` case (AS-04).
- The facts list no source files except the queue configuration, so no `` clause is given.

### Claims the generator could not verify (removed from the rules above)
- code ref `...` (file not found: ...)
