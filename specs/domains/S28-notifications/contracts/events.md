# Contract: events and messages — consumed, produced, queues

S28 **produces no domain events and no outbox rows** (R1 exports: none). It consumes the rows below, validating each payload with the named zod schema before acting (IV.5), over the S53 envelope `{eventId, type, version, occurredAt, aggregateId}`. Schema location: `orders`/`payments` = the producer's file in `packages/contracts`; everything marked *consumer schema* = `packages/contracts/src/notifications/consumed-events.ts` (fields rendered only; see research R-3).

## Consumed

| Source (owner) | Topic / queue | Type v | Payload fields used | Schema | Catalog type(s) | Dedupe source id |
|---|---|---|---|---|---|---|
| identity (S01) | `identity.events` | `identity.user_registered` v1 | `userId` | consumer | `account.welcome` | `eventId` |
| identity | same | `identity.registration_duplicate_attempted` v1 | `userId` (never the attempted address) | consumer | `security.registration_attempt` | `eventId` |
| identity | same | `identity.password_changed` v1 | `userId` | consumer | `security.password_changed` | `eventId` |
| identity (S02) | same | `identity.mfa_enabled` / `mfa_disabled {reason}` / `mfa_recovery_code_used {remaining}` / `mfa_recovery_codes_regenerated` v1 | `userId`, listed fields | consumer | `security.mfa_*`, `security.recovery_*` | `eventId` |
| identity (S02) | same | `identity.federated_identity_linked {provider, linkMethod, passwordInvalidated, mfaReset}` / `federated_identity_unlinked {provider}` v1 | listed | consumer | `security.sign_in_method_added|removed` (text mentions removed password / reset MFA when flags true) | `eventId` |
| tenancy (S03) | SQS `tenancy-invite-requested` (single consumer, outbox task) | `tenancy.invite_requested` v1 | `{inviteId, shopId, shopName, email, role, token, expiresAt, invitedBy}` | consumer | `shop.invite` | `inviteId` |
| tenancy | `tenancy.events` | `tenancy.shop_offboarding_started` v1 `{shopId, purgeAt, shopVersion}`; `shop_offboarding_cancelled`; `shop_deleted` (not mailed; recorded as ignored `reason=not_mapped`) | `shopId`, `purgeAt` | consumer | `shop.offboarding_started|cancelled` | `eventId` |
| shop onboarding (S04) | `shop-onboarding` | `shop.verified`, `shop.rejected {reasonCode}`, `shop.onboarding_document_rejected {kind, reason}` v1 | listed | consumer | `shop.verified|rejected|document_rejected` | `eventId` |
| orders (S10) | `orders.events` | `order.paid` | `orderId, userId, totalMinor, currency, shopOrders[{shopId, subtotalMinor}], orderVersion` | producer | `order.confirmed`, `shop.order_received` (one per shop) | `eventId` |
| orders | same | `order.cancelled` (reasons `out_of_stock`, `hold_expired` only), `order.refunded`, `order.fulfilment_changed` (`SHIPPED`, `DELIVERED`; needs `userId`, see R-4) | listed | producer | `order.cancelled|refunded|shipped|delivered` | `eventId` |
| payments (S13) | `payments.events` | `payments.payment_failed` v1 (not for `order_not_payable`, `order_cancelled`) | `userId, orderId, amountMinor, currency, reasonCode, paymentVersion` | producer (`paymentEventSchemas`) | `payment.failed` | `eventId` |
| delivery (S20) | `delivery.events` | `delivery.status_changed` v1 (`PICKED_UP`, `CANCELLED`) | `buyerId, orderId, status, deliveryVersion` | consumer | `delivery.picked_up|cancelled` | `eventId` |
| auctions (S21) | `auctions.events` | `auction.leader_changed`, `auction.closed`, `auction.second_chance_offered`, `auction.sold` | `priceMinor`/`finalPriceMinor`, `currency`, `auctionVersion`, ids | consumer | `auction.outbid|won|second_chance|sold` | `eventId` |
| billing (S17) | `billing.events` | `billing.invoice_payment_failed`, `billing.invoice_paid` | `subjectType, subjectId, attempt, nextAttemptAt, reason, totalMinor, currency` | consumer | `billing.payment_failed|access_withdrawn|receipt` | `eventId` |
| payouts (S15) | `payouts.events` | `payout.paid`, `payout.failed` | `payoutId, shopId, amountMinor, currency, payoutVersion` | consumer | `payout.paid|failed` | `eventId` |
| launch events (S22) | `launch-events.events` | `launch_events.booking_confirmed` | `userId, seats, launchEventId` | consumer | `booking.confirmed` | `eventId` |
| chat (S24) | `chat.events` | `chat.message_escalated` v1 | `recipientId, channelId, channelTitle, preview, dedupeKey` | consumer | `chat.message` | `dedupeKey` |
| discussions (S25) | `discussions.events` | `discussion.comment_created` v1 | `postId, authorId, parentAuthorId, postAuthorId, preview` | consumer | `discussion.reply|comment` | `eventId` |
| seller-insights (S41) | `seller-insights.events` | `seller_insights.competitor_price_dropped` v1 | `watchId, shopId, productId, productTitle, host, competitorPriceMinor, yourPriceMinor, currency, ownerId` | consumer | `insights.competitor_price_drop` | `eventId` |
| developer-platform (S43) | `developer-platform.events` | `developer_platform.webhook_endpoint_disabled` v1 | `endpointId, shopId, host, failingSince` | consumer | `developers.webhook_endpoint_disabled` | `eventId` |
| community (S26) | `feed.events` | `feed.item_published` v1 kinds `drop_announced`, `auction_started` | `itemId, authorId, kind, createdAt` | consumer | `marketing.followed_shop_update` (paged fan-out, port R-5) | `eventId` |

Topic names above are the consumer's subscription config (`notifications.topics.ts`, one constant per row); they are checked against the producers' actual topic names when each producer ships, with the mismatch listed as a sibling follow-up. The existing subscriptions (`orders.events`, `auctions.events`, `billing.events`) keep their names.

Outcomes for any message: **mapped** (≥ 1 request), **ignored** (valid but unmapped type, or filtered reason: counter `notifications_events_ignored_total{reason}`), **dead-lettered** (`invalid_payload`, `unsupported_version`, `render_failed`; reason + event id in the record; for `tenancy.invite_requested` no body). A consumed batch is processed per request in isolation (G-03).

## Not consumed (recorded)

`identity.password_reset_requested` (not emitted, see R-1), `payments.payment_succeeded|refunded`, `delivery.status_changed DELIVERED`, `billing.subscription_status_changed`, `statements.*`, `ledger.reconciliation_*`, `payout.in_doubt|discrepancy_detected`, `integration_*`, `catalog_sync.*`, `order_export.finished`, `flash_sale.*`, `live.*`.

## Internal queues (owned by S28, names are its contract with ops)

| Queue | Purpose | Visibility / receives | DLQ |
|---|---|---|---|
| `notify-email`, `notify-sms`, `notify-push` | transactional lines | 60 s, 5 attempts handled by the worker | `…-dlq` |
| `notify-marketing-email`, `notify-marketing-sms`, `notify-marketing-push` | marketing lines | same, lower concurrency | `…-dlq` |
| `notifications-callbacks` | accepted provider callbacks | 60 s, dedupe id = provider event id | `notifications-callbacks-dlq` |

Realtime out: `user:<userId>` event `notification`.
