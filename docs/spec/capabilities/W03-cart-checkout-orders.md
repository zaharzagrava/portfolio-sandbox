---
id: W03
title: Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S10, S13, S51, S48, S28, W01, W02, W07]
concepts: [idempotency-key, order-reservation, payment-lifecycle, realtime-topic-stream, bff-aggregate, problem-json-errors, rate-limit-policy]
models: []
scope:
  - packages/contracts/src/bff/**
---
# W03 - Cart, checkout, payment status, order history and notifications
## Purpose
A visitor fills a cart without an account, signs in, and the guest cart follows. The member reviews the order, places it once however often they press the button, pays, and watches the payment settle. The member then sees an honest confirmation and later finds the order in their history. Signed-in members also get a notification bell with a live inbox.

## Entry points
- `/cart`: cart page for guests and members, lines grouped by shop, with quantity change, removal with undo and the merge notice.
- Cart badge and **Add to cart** button: used on every page; the badge shows the unit count.
- `/checkout`: review screen with the **Place order** action. It redirects anonymous visitors to sign-in on the server.
- `/checkout/pay/{orderId}`: reservation countdown, hosted card fields, payment status panel.
- `/checkout/success/{orderId}`: order confirmation page.
- `/orders`: order history, newest first, paged with `?cursor=`. `/dashboard/orders` redirects permanently to it.
- `/orders/{orderId}`: order detail with timeline and payment panel. Notification links also open it.
- Notification bell and popover in the navbar for signed-in members.
- Live stream `GET /api/streams?topics=user:{userId}`: events `order.status`, `payment.status`, `notification`, `resync`, `revoked`.
- API used: `GET /orders/`, `GET /orders/:orderId`, `POST /orders/:orderId/cancel` [code: packages/backend/libs/domains/orders/api/orders.controller.ts#OrdersController]; `POST /payments/intents`, `GET /payments`, `GET /payments/:paymentId` [code: packages/backend/libs/domains/payments/api/payment.controller.ts#PaymentController].

## Rules
- **W03.R-01** The cart badge MUST show the unit count, show `99+` above 99, and be absent until the count is known. [proof: W03 AS-13]
- **W03.R-02** Cart lines MUST be grouped under "Sold by {shop name}", and a line with an unknown shop MUST sit under "Other items". [proof: W03 AS-03]
- **W03.R-03** A quantity change MUST update the interface before the answer, and writes for one product MUST be sent one at a time in order. [proof: W03 AS-04]
- **W03.R-04** The **−** control MUST be disabled at quantity 1, and **+** MUST be disabled at quantity 20. [proof: W03 AS-06]
- **W03.R-05** A line whose product is `null` without a `products` error MUST show "No longer available" and MUST NOT count in the subtotal. [proof: W03 AS-08]
- **W03.R-06** A failed guest-cart merge MUST NOT show an error at sign-in, and MUST NOT block the next cart read. [proof: W03 AS-12]
- **W03.R-07** `/checkout` MUST redirect an anonymous visitor on the server to `loginHref('/checkout')` before any checkout content is sent. [proof: W03 AS-14]
- **W03.R-08** The UI MUST send one order request at a time; a second press while the first is pending MUST be ignored. [proof: W03 AS-18]
- **W03.R-09** The UI MUST reuse the same {{concept:idempotency-key}} for retries of one attempt, including after a reload, because the attempt is kept in the tab's session storage. [proof: W03 AS-19, W03 AS-20]
- **W03.R-10** A `202` with `Idempotency-Replayed: true` MUST behave as a first `202`. [proof: W03 AS-21]
- **W03.R-11** On `409 idempotency_in_flight` the UI MUST retry with the same key, at most 5 times, after at least 1 second. [proof: W03 AS-22]
- **W03.R-12** On `409 price_changed` the UI MUST show the old and new unit prices and the new total, and MUST NOT place the order until the buyer accepts. [proof: W03 AS-23]
- **W03.R-13** Each checkout problem MUST have its visible form chosen by the stable problem `code`, as defined for {{concept:problem-json-errors}}. [proof: W03 AS-24, W03 AS-25, W03 AS-26, W03 AS-27, W03 AS-28, W03 AS-30, W03 AS-31]
- **W03.R-14** On `429 rate_limited` the UI MUST disable **Place order** until the `Retry-After` time has passed. [proof: W03 AS-29]
- **W03.R-15** While the browser is offline, **Place order** and **Pay** MUST be disabled with the banner "You're offline. Reconnect to place your order." [proof: W03 AS-33]
- **W03.R-16** The browser MUST NOT read the `__Host-ref` cookie; the server adds the referral code only when `checkoutRequestSchema` declares the field. [proof: W03 AS-34]
- **W03.R-17** An order page MUST show a not-found page for a malformed id, an unknown order and another member's order, and never a 403 form. [proof: W03 AS-35, W03 AS-50]
- **W03.R-18** When the payment is `COMPLETED` and the order is still `RESERVED`, the page MUST show "Payment received. Confirming your order…" and MUST NOT show "confirmed". [proof: W03 AS-46]
- **W03.R-19** When the payment is `UNKNOWN`, the page MUST show no **Pay** button. [proof: W03 AS-42]
- **W03.R-20** **Cancel** MUST be offered only for `RESERVED` orders, **Pay now** only for `RESERVED`, and **Buy these items again** only for `CANCELLED`. [proof: W03 AS-51, W03 AS-54, W03 AS-59]

## Behaviors
- **W03.B-01** Given a visitor with no cart, when they open `/cart`, then they see "Your cart is empty" with **Browse products** and no badge number. [proof: W03 AS-01]
- **W03.B-02** Given a product page, when the visitor presses **Add to cart**, then the button shows "Adding…", a toast "Added to cart" appears, the badge updates and `add_to_cart` is emitted. [proof: W03 AS-02, W03 AS-75]
- **W03.B-03** Given a line, when the shopper presses **Remove**, then the line disappears, and a toast with **Undo** shows for 8 seconds. [proof: W03 AS-05]
- **W03.B-04** Given `422 cart_line_limit` on a write, then the alert reads "Your cart is full (50 different items). Remove one to add another." [proof: W03 AS-07]
- **W03.B-05** Given a guest with a non-empty cart, then the primary action reads **Sign in to check out**. [proof: W03 AS-10]
- **W03.B-06** Given a guest cart and a member cart, when sign-in merges them, then quantities are summed, and a notice shows if lines were dropped. [proof: W03 AS-11]
- **W03.B-07** Given a member with a non-empty cart, when `/checkout` opens, then they see the Review step, lines by shop and the estimated total. [proof: W03 AS-15]
- **W03.B-08** Given a member with an empty cart, then `/checkout` shows "Your cart is empty" and no **Place order** button. [proof: W03 AS-16]
- **W03.B-09** Given the review screen, when the member presses **Place order** and the answer is `202`, then the page moves to `/checkout/pay/{orderId}` and the cart badge is empty. [proof: W03 AS-17]
- **W03.B-10** Given `422 out_of_stock`, then the alert names the products by title and **Place order** stays enabled. [proof: W03 AS-24]
- **W03.B-11** Given `422 product_unavailable`, when the buyer presses **Remove unavailable items**, then exactly those lines are removed and the cart is re-read. [proof: W03 AS-25]
- **W03.B-12** Given `422 cart_empty`, then the empty state shows with a link to `/orders`. [proof: W03 AS-27]
- **W03.B-13** Given `409 checkout_in_progress`, then the alert points to **Your orders** and **Place order** is enabled. [proof: W03 AS-28]
- **W03.B-14** Given `503 checkout_unavailable`, then the alert says nothing was charged and the retry sends the same key. [proof: W03 AS-30]
- **W03.B-15** Given an answer `401` while placing, then the session-ended flow of {{cap:W01}} runs and the stored attempt is used after sign-in. [proof: W03 AS-32]
- **W03.B-16** Given a payable order, when the buyer presses **Pay**, then the button shows "Paying…" and the token goes to `POST /payments/intents` with an idempotency key. [proof: W03 AS-37, W03 AS-38, W03 AS-47]
- **W03.B-17** Given a `FAILED` payment, then the panel shows "Payment didn't go through" with the sentence for the failure code. [proof: W03 AS-41]
- **W03.B-18** Given a `PAID` order, then the success page shows "Order confirmed", "Order #{SHORT}" and the lines. [proof: W03 AS-48, W03 AS-49]
- **W03.B-19** Given a `CANCELLED` order, then the buyer sees "This order was cancelled" with the reason; **Buy these items again** refills the cart. [proof: W03 AS-43, W03 AS-59]
- **W03.B-20** Given the stream delivers `order.status`, then the list or detail page re-reads and shows the new status. [proof: W03 AS-58]

## Lifecycles
No model is listed. Order statuses and their text: `PENDING` "Processing", `RESERVED` "Awaiting payment", `PAID` "Paid", `FULFILLING` "Preparing", `SHIPPED` "Shipped", `DELIVERED` "Delivered", `CANCELLED` "Cancelled", `REFUNDED` "Refunded". The backend moves them; this capability shows them (see {{concept:order-reservation}}, {{concept:payment-lifecycle}}). The pay step has phases `idle | tokenizing | submitting | processing | actionRequired | confirming | unknown | failed | completed | expired`, changed only by a pure reducer.

## Owns
- Browser storage: `w03.attempt.checkout` and `w03.attempt.pay:{orderId}` in session storage, expiring after 24 hours.
- Query keys `cart`, `orders`, `payments`, `notifications` in `lib/query-keys.ts`.
- Reads the live stream of `user:{userId}` ({{concept:realtime-topic-stream}}) and the cart and order page aggregates ({{concept:bff-aggregate}}).
- Owns no database table, queue or topic.

## Decisions
- Place order uses an attempt key kept in session storage, so a double press or reload creates one order ({{concept:idempotency-key}}).
- Failure forms are chosen by problem `code`, never by `detail` text.
- Money is formatted from integer minor units and the currency of the same object.
- The browser holds no token; the server turns the session cookie into a bearer token.
- Order-lag after payment shows "Confirming" rather than "confirmed", so the page does not overstate.

## Known gaps
- No test carries an id for AS-09 error and partial forms in the cart (AS-09 is covered only by a review test whose name differs), AS-52, AS-56, AS-60, AS-67, AS-69, AS-74.
- AS-09 and AS-08 proofs exist, but they sit in tests for other components; the cart loading, error and partial states are not asserted by proof here.
- Rules for AS-36 (countdown), AS-39 (polling after 10 seconds), AS-40 (3-D Secure) and AS-45 (stream banner) have tests, but no rule above states them; they are not described in detail.
- AS-73 (text and money rendering), AS-71 and AS-72 (browser secrets) have tests, but are not stated as rules.
- AS-62 to AS-66 (notification inbox) have tests, but the behaviors are not written here.
- AS-74 accessibility and AS-69 layout have no test.
- Rules R-01 to R-20 carry no `` clause because the UI source files are not in the file list.