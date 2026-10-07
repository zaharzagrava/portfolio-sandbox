# Feature Specification: W03 — Cart (guest, merged on login), checkout with idempotent submit, pay step with async payment status, success page, order history and detail, notification popover (`packages/web`)

**Capability**: W03 · **Area**: web (`packages/web`, Next.js 16, App Router, Cache Components on) · **Spec directory**: `specs/web/W03-cart-checkout-orders`

**Feature Branch**: `W03-cart-checkout-orders` (spec directory only; no branch was created)

**Created**: 2026-10-07

**Status**: Draft

**Input**: "Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover (the Next.js app in `packages/web`)". Sources: constitution V, VI, VII.7; `packages/web/AGENTS.md` and the Next.js guides *Authentication with Cache Components*, *Rendering philosophy*, *Building interactive apps*, `instant`; `docs/architecture/pattern-map.md` (rows naming W03: P0414, P0901); backend specs S10, S13, S28, S51 (and S11, S39, S48 for what they require of W03); web specs W01, W02; interview-prep `09-frontend-react-next/01-react-state-management.md`; the current `app/cart`, `app/checkout`, `app/dashboard/orders`, `components/notifications-popover.tsx`, `components/add-to-cart-button.tsx`, `lib/api/{cart,orders,client,sse,errors}.ts`, `hooks/{use-auth,use-event-stream}`, `tests/cart-checkout.spec.ts`.

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged), [`test-plan.md`](test-plan.md) (one row per scenario), [`gaps.md`](gaps.md) (what today's code lacks, missing backend endpoints, test tooling), [`checklists/requirements.md`](checklists/requirements.md).

## Scope

A visitor fills a cart without an account, signs in (the guest cart follows), reviews the order, places it once however often the button is pressed, pays, watches the payment settle, sees an honest confirmation, and later finds the order in their history. Signed-in members also see a notification bell with an inbox that updates live.

In scope (every screen and state a visitor or member reaches through these flows):

- **Cart** (`/cart`): lines grouped by shop, quantity changes, removal with undo, partial and unavailable products, guest and signed-in views, the notice after the guest cart was merged, and the **cart badge** and **add-to-cart behaviour** used on every other page.
- **Checkout review** (`/checkout`): order summary, the idempotent **Place order** action, and the visible form of every checkout problem.
- **Pay step** (`/checkout/pay/{orderId}`): reservation countdown, the provider's hosted card fields, 3-D Secure, and the asynchronous payment status (processing, action required, unknown, failed, completed) followed live with a polling fallback.
- **Success page** (`/checkout/success/{orderId}`): shown truthfully: "confirmed" only when the order is `PAID`.
- **Order history** (`/orders`) and **order detail** (`/orders/{orderId}`): keyset paging in the URL, status, timeline, per-shop slices, payment panel, cancel, pay now, buy again.
- **Notification popover** (bell in the navbar): unread count, inbox, mark read, live arrival, reconnect behaviour.
- Layout at mobile (≤ 640 px) and desktop (≥ 1024 px), keyboard and screen-reader access, the visible form of every backend error these flows can meet, and the rendering and state rules of constitution VI for these pages.

Out of scope (owners named):

- Cart, order, stock, payment, inbox and realtime rules → **S10**, **S13**, **S28**, **S51**. This spec cites their scenario IDs and specifies only how the UI shows and handles them.
- Composition of cart lines and of an order with its payment → **S48** (BFF, constitution IX.7 R2). New endpoints are named under Cross-capability contracts.
- Sign-in, session handling, guards' helpers, the session-ended flow, CSRF header, the problem renderer → **W01**; product page, search, `track`, `newIdempotencyKey`, `getRefCode`, `productHref`, `searchHref`, `formatMoney` → **W02**; navbar frame, skip link, global error and not-found pages, security headers and CSP → **W07**.
- The notification **preferences screen** (S28 lists W03 as a consumer of those endpoints): not specified here, see `questions.md`.
- Seller-side order lists (`GET /shops/:shopId/orders`) and the seller dashboard → **W04**. Flash-sale and auction purchase screens → their own web capabilities (this spec only renders the extra checkout problem codes S11 adds).
- Downloads of digital goods from an order (S31 asked W03): deferred until S31 defines the read it needs (`questions.md`).
- Shipping address, shipping fees, taxes, discount-code entry, saved cards, refunds initiated by the buyer: not modelled by the backend.

## User Scenarios & Testing *(mandatory)*

Notation: scenario IDs are `AS-nn`; `test-plan.md` maps each to exactly one row. "S10 AS-14" means scenario AS-14 of the S10 spec; backend rules are cited, never re-specified. Amounts are integer minor units formatted with `formatMoney(minor, currency)`; `€` examples use EUR. "The cart aggregate" and "the order aggregate" are the BFF endpoints of Cross-capability contracts. Widths: **mobile** ≤ 640 px, **desktop** ≥ 1024 px; between them the mobile structure is used with more room, never a horizontal scrollbar. Visible copy is quoted; it is the *Copy catalogue* (FR-080) and is the only text tests assert.

### User Story 1 — A visitor keeps a cart, signed out or signed in, and it follows them through login (Priority: P1)

A visitor adds products, adjusts quantities, removes a line by mistake and undoes it, signs in, and finds everything still there.

**Why this priority**: the cart is the entry of the whole flow; a lost line, a wrong quantity or a dead button loses the sale.

**Independent Test**: add a product as a guest, sign in, open the cart, change the quantity, remove and undo; assert lines, quantities and the badge.

**Acceptance Scenarios**:

1. **AS-01** (empty cart, guest) — **Given** a visitor with no cart, **When** they open `/cart`, **Then** the heading **Your cart** is followed by the empty state "Your cart is empty" with a **Browse products** link (`searchHref({})`), no summary, no checkout button, and the navbar cart badge shows no number. (S10 AS-01.)
2. **AS-02** (add to cart) — **Given** a product page, **When** the visitor presses **Add to cart**, **Then** the button shows "Adding…" and is disabled until the answer, then a status toast "Added to cart" with a **View cart** action appears, the badge shows the new unit count, and one `add_to_cart` event is emitted with `product_id` and `category`; pressing again adds one more unit (the cart is read first because the API sets absolute quantities). (S10 AS-03; S39.)
3. **AS-03** (cart page, loaded) — **Given** a cart of lines from two shops, **When** `/cart` opens, **Then** lines are grouped under a heading "Sold by {shop name}" (a line whose shop is unknown sits under "Other items"); each line shows image (or placeholder), title as a link to `productHref(productId)`, unit price, quantity control, line total, **Remove**; the summary shows "Subtotal ({n} items)" and a primary **Checkout** action; a **Continue shopping** link goes to `searchHref({})`. Layout per FR-040.
4. **AS-04** (change quantity) — **Given** a line with quantity 2, **When** the shopper presses **+**, **Then** the quantity and the line total and subtotal change at once (before the answer), the control for that line carries `aria-busy` until settled, writes for the same product are sent one at a time in order (the last value wins), and the lines are re-read after the last write settles; on failure the previous values come back and an alert toast explains (AS-07). (S10 AS-03.)
5. **AS-05** (remove and undo) — **Given** a line, **When** the shopper presses **Remove**, **Then** the line disappears at once, a status toast "Removed {title}" with an **Undo** action shows for 8 seconds and focus moves to the next line (or to the heading when none is left); **When** **Undo** is pressed, **Then** the line returns with its previous quantity; **When** the toast expires, **Then** nothing more happens (the removal is already saved). (S10 AS-03.)
6. **AS-06** (quantity bounds, UI only) — **Given** a line at quantity 1 and another at 20, **Then** **−** is disabled on the first (removal is the explicit **Remove**) and **+** is disabled on the second with the hint "Maximum 20 per item" (`aria-describedby`); **When** a number is typed into the quantity field and committed (Enter or blur), **Then** a value from 1 to 20 is sent, anything else (empty, 0, 21, decimals, text) reverts to the last saved value and announces "Enter a quantity from 1 to 20". (S10 AS-03 proves the 400.)
7. **AS-07** (write failures) — **Given** a quantity change or add, **When** the API answers `422 cart_line_limit`, **Then** the alert toast reads "Your cart is full (50 different items). Remove one to add another."; **`429 rate_limited`** with `Retry-After` → "You're changing the cart too fast. Try again in {wait}."; a network failure → "You're offline. The change wasn't saved."; any other problem → the FR-082 generic form; in every case the displayed values are rolled back to the last saved cart. (S10 AS-03, AS-10.)
8. **AS-08** (unavailable and out-of-stock lines) — **Given** the cart aggregate returns a line whose `product` is `null` with no `products` entry in `errors`, **Then** the line shows "No longer available" (title replaced by "Unavailable product"), its price cells show "—", it keeps **Remove**, and it is excluded from the subtotal; **Given** `product.inStock` is false, **Then** the line shows an "Out of stock" label and still counts in the subtotal (exact stock is only decided at checkout); neither blocks the **Checkout** action. (S10 AS-21.)
9. **AS-09** (loading, error, partial) — **Given** the cart is loading, **Then** the page shows its heading and a skeleton of three lines with `role="status"` text "Loading your cart"; **Given** the read fails, **Then** an alert "We couldn't load your cart." with a **Try again** button (and the FR-082 form for `429` and `5xx`); **Given** the aggregate answers with an `errors` entry for `products`, **Then** lines show quantity, **Remove** and "Details unavailable right now" in place of title and price, the subtotal row reads "Subtotal unavailable", a banner "Some product details couldn't be loaded." has a **Reload** button, and the **Checkout** action stays enabled. (S48.)
10. **AS-10** (guest checks out) — **Given** a guest with a non-empty cart, **Then** the primary action reads **Sign in to check out** and links to `loginHref('/checkout')`; **When** the visitor signs in, **Then** they land on `/checkout` with their guest lines merged (AS-11). (W01 AS-01; S10 AS-08.)
11. **AS-11** (merge after sign-in) — **Given** a guest cart and a member cart, **When** W01 calls `mergeGuestCart()` after sign-in, **Then** the cart shows the summed quantities (S10 AS-05); **When** the answer carries `droppedLines: n > 0`, **Then** the cart page shows a dismissible status notice "{n} items from your guest cart couldn't be added because a cart holds at most 50 different items." until dismissed or until the next full page load; **When** `droppedLines` is 0 nothing is shown. (S10 AS-05, AS-07.)
12. **AS-12** (merge failure is silent) — **Given** the merge request fails (network, `429`, `5xx`), **When** sign-in completes, **Then** no error is shown at sign-in, the cart page shows the member's own cart, and the next cart read is not blocked by the failed merge. (S10 AS-06; W01 FR-007.)
13. **AS-13** (cart badge) — **Given** any page, **Then** the navbar cart link has the accessible name "Cart, {n} items" (or "Cart" while unknown or empty), the badge shows the unit count (`99+` above 99) and is absent until the count is known; the count follows every cart change in the same tab at once, and a cart changed in another tab or on another device shows after the tab regains focus. (W07 mounts `<CartBadge />`.)

---

### User Story 2 — A buyer places an order once, however often the request is repeated (Priority: P1)

A signed-in buyer reviews the cart and presses **Place order** on a flaky connection: the browser retries, the buyer double-clicks, the page is reloaded, a second tab is open. Exactly one order is created, and every problem has a clear next step.

**Why this priority**: a double order or a wrong price is direct money loss; this is the UI half of idempotency (P0414).

**Independent Test**: place an order with the double click and a reload mid-request; assert one order, then force each problem code and assert the visible form.

**Acceptance Scenarios**:

1. **AS-14** (guard) — **Given** an anonymous visitor, **When** they open `/checkout`, **Then** they are redirected on the server to `loginHref('/checkout')` before any checkout content is sent; after signing in they return to `/checkout`. (W01 AS-27, AS-65; S10 AS-21.)
2. **AS-15** (review screen) — **Given** a member with a non-empty cart, **When** `/checkout` opens, **Then** the page shows a progress list "Review" (current) → "Pay" with `aria-current="step"`, the lines grouped by shop (title, quantity, line total), "Estimated total" with the formatted amount, the note "Placing the order holds your items for 15 minutes while you pay.", and a **Place order** button. Layout per FR-041.
3. **AS-16** (empty cart on checkout) — **Given** a member with an empty cart, **When** `/checkout` opens, **Then** the page shows "Your cart is empty" with **Browse products** and no **Place order** button. (S10 AS-21.)
4. **AS-17** (place order, happy path) — **Given** AS-15, **When** the member presses **Place order**, **Then** the button shows "Placing order…" and is disabled with `aria-busy`, on `202` the page moves to `/checkout/pay/{orderId}` (the `orderId` from the body; the `Location` header is not parsed), the cart badge becomes empty, one `checkout_step` event `{step: "review"}` was emitted on the review view and `{step: "pay"}` on the pay view. (S10 AS-13.)
5. **AS-18** (one request at a time) — **Given** the member presses **Place order** twice quickly (or presses Enter twice), **Then** one request is sent; the second press is ignored while the first is pending. (S10 AS-17.)
6. **AS-19** (key lifecycle, UI logic) — **Given** the order-attempt logic, **Then**: an attempt is `{key, expectedTotalMinor}` created at the first press; the **same key** is reused for an automatic or manual retry of that attempt after a network failure, a `503`, a `409 idempotency_in_flight` and a `409 price_changed` re-confirmation (the body changes only to the total the buyer just accepted, S10 AS-14/AS-20: no order existed, so the key is unused); a **new key** is made when the buyer presses again after `out_of_stock` (final for that key, S10 AS-20) and when the cart's content changed since the attempt began; the key is a UUID from `newIdempotencyKey()`; an attempt older than 24 hours is dropped (S10 FR-012). (S10 AS-18, AS-20; P0414.)
7. **AS-20** (reload during the request) — **Given** a request is in flight, **When** the member reloads the page and presses **Place order** again, **Then** the attempt is restored from the tab's session storage and the same key is sent, so the server answers with the one order (`202`, possibly `Idempotency-Replayed: true`, or `409 idempotency_in_flight` first, see AS-22) and no second order exists; on success, on a final outcome and on sign-out the stored attempt is deleted. (S10 AS-15, AS-16.)
8. **AS-21** (replay is success) — **Given** the answer is `202` with `Idempotency-Replayed: true`, **Then** the UI behaves exactly as for a first `202` (AS-17). (S10 AS-15.)
9. **AS-22** (in flight) — **Given** `409 idempotency_in_flight` with `Retry-After`, **Then** the button stays "Placing order…", the request is retried automatically with the same key after the advertised delay (at least 1 s), at most 5 times; **When** all fail, **Then** an alert "We're still processing your order. Check **Your orders** before trying again." with a link to `/orders` and **Place order** enabled again with the same key. (S10 AS-16, AS-30.)
10. **AS-23** (price changed) — **Given** `409 price_changed {currentTotalMinor, lines}`, **Then** an alert (focus moved to it) reads "Prices changed since you added these items.", lists each changed line with its old and new unit price from `lines`, shows "New total: {amount}", and offers **Accept new total and place order** (retries with the new `expectedTotalMinor`) and **Back to cart**; the order is never placed without that press. (S10 AS-14.)
11. **AS-24** (out of stock) — **Given** `422 out_of_stock {productIds}` (also with `flashSaleId`, S11), **Then** an alert "Not enough stock for: {titles}. Nothing was reserved." names the products by title, the matching lines carry an "Out of stock" label, and **Review cart** links to `/cart`; **Place order** is enabled and uses a new key. (S10 AS-32, AS-33.)
12. **AS-25** (product unavailable) — **Given** `422 product_unavailable {productIds}`, **Then** an alert "Some items can't be bought any more: {titles}." with a **Remove unavailable items** button that removes exactly those lines (one write each) and then re-reads the cart; **Place order** stays disabled while that runs. (S10 AS-21.)
13. **AS-26** (mixed currency) — **Given** `422 mixed_currency`, **Then** an alert "Your cart has items priced in different currencies. Remove the items of one currency to continue." with **Back to cart**. (S10 AS-21.)
14. **AS-27** (cart empty at submit) — **Given** `422 cart_empty` (the cart was emptied in another tab or by a checkout that already succeeded), **Then** the page shows the AS-16 empty state plus "If you just placed an order, you'll find it in **Your orders**." with a link to `/orders`. (S10 AS-21, AS-27.)
15. **AS-28** (another checkout running) — **Given** `409 checkout_in_progress`, **Then** an alert "Another checkout for your cart is in progress. Check **Your orders** or try again in a moment." with the `/orders` link; **Place order** is enabled. (S10 AS-27.)
16. **AS-29** (rate limited) — **Given** `429 rate_limited` with `Retry-After`, **Then** an alert "Too many attempts. Try again in {wait}." is shown, **Place order** is disabled and re-enabled automatically when the time has passed (the countdown text updates at most once per second and is announced only at the start and the end). (S10 AS-26; W01 FR-041.)
17. **AS-30** (temporarily unavailable) — **Given** `503 checkout_unavailable` with `Retry-After` (or a network failure), **Then** an alert "Checkout is temporarily unavailable. Nothing was charged. Try again in a moment." with **Place order** enabled; the retry sends the same key (the server may already hold an order, S10 AS-30). (S10 AS-30.)
18. **AS-31** (client-side misuse and unknown failures) — **Given** `422 idempotency_key_reuse | idempotency_key_required | idempotency_key_invalid`, `400 validation_failed`, or any `5xx`, **Then** the FR-082 generic alert (with "Reference: {requestId}" when the body has one) is shown, the stored attempt is replaced by a new one, and nothing else changes. (S10 AS-14, AS-18; constitution V.3.)
19. **AS-32** (session ended while placing) — **Given** the session ended on the server, **When** **Place order** is pressed and the answer is `401`, **Then** W01's session-ended flow runs once (AS-26 of W01), the guard redirects to sign-in with `returnTo=/checkout`, and after signing in the stored attempt (same key) is used if the cart is unchanged. (W01 AS-26; S10 AS-21.)
20. **AS-33** (offline) — **Given** the browser is offline, **Then** a banner "You're offline. Reconnect to place your order." (`role="status"`) is shown on the review screen and **Place order** is disabled; when the browser is back online the banner disappears and the button is enabled. (Browser online/offline signals.)
21. **AS-34** (referral code) — **Given** the referral cookie `__Host-ref` holds a code (W02 AS-63), **When** the order is created, **Then** the server-side order function adds the code to the request only when `checkoutRequestSchema` declares the field; the browser never reads the cookie; no visible change. (S37; S10 questions.)

---

### User Story 3 — A buyer pays and watches the payment settle (Priority: P1)

After the reservation the buyer enters card details in the provider's hosted fields, confirms 3-D Secure if asked, and sees the real outcome: processing, confirmed, declined, or "we're still checking with your bank". The page never claims success before the order is paid and never invites a second payment while one may be running.

**Why this priority**: the asynchronous payment is where money and trust are decided; the UI must follow the backend's states, not guess.

**Independent Test**: pay with the sandbox card and follow the page to the success page; then force each payment state with stubbed answers and assert the visible form.

**Acceptance Scenarios**:

1. **AS-35** (access and order states) — **Given** `/checkout/pay/{orderId}`, **Then**: anonymous → server redirect to sign-in with `returnTo`; a malformed id, an unknown order and another member's order → the same not-found page (never a 403 form); order `RESERVED` and not expired → the pay form (AS-37); `PENDING` → "Reserving your items…" (`role="status"`, live updates, FR-050); `PAID`, `FULFILLING`, `SHIPPED`, `DELIVERED` → redirect to `/checkout/success/{orderId}`; `CANCELLED` or `REFUNDED` → AS-43. (S10 AS-58, AS-55.)
2. **AS-36** (countdown) — **Given** `reservedUntil`, **Then** the page shows "Items reserved for {mm:ss}" in an element with `role="timer"` (not read out every second), a polite status announces "Your reservation ends in 5 minutes", "…in 1 minute" and "Your reservation has ended"; **When** it reaches zero and no payment is in progress, **Then** the order is re-read and the page shows the state the server reports (normally AS-43 with reason `hold_expired`); **When** a payment is in progress (AS-39 to AS-42), **Then** the countdown is replaced by "Payment in progress" and expiry is not announced; the server's status, never the browser clock, decides. (S10 AS-36.)
3. **AS-37** (pay form) — **Given** a payable order, **Then** the page shows the order summary (lines by shop, total in the order's currency), a group "Card details" with the provider's hosted fields (card number, expiry, security code live in the provider's frames; their labels are "Card number", "Expiry date", "Security code"), and a **Pay {amount}** button disabled until the fields report complete; the page's own DOM and scripts never see card data; provider field errors appear under the field (`aria-describedby`, `role="alert"` on submit). Layout per FR-042. (S13 AS-02, AS-63.)
4. **AS-38** (pay, happy path) — **Given** AS-37, **When** the buyer presses **Pay**, **Then** the button shows "Paying…" and is disabled; the provider's token is sent to `POST /payments/intents {orderId, paymentMethodId}` with a new idempotency key (a double press, a reload and a retry reuse the attempt's key as in AS-19); on `202` the panel shows "Payment is being processed…" (`role="status"`), then "Payment received. Confirming your order…" when the payment is `COMPLETED`, then the page moves to `/checkout/success/{orderId}` when the order is `PAID`. (S13 AS-01, AS-15; S10 AS-41.)
5. **AS-39** (processing and live updates) — **Given** a payment `PENDING` with no action required, **Then** the panel shows the processing message, the form is hidden, and the status follows the live stream (events `payment.status` and `order.status`); **When** the stream is down or silent for 10 seconds, **Then** the page polls the order aggregate every 2 seconds for 30 seconds and then every 5 seconds for 5 minutes (at most 30 requests per minute), and stops with "This is taking longer than expected. You can leave this page; we'll email you and it will show in **Your orders**." plus a **Check again** button. (S13 AS-21; S51 AS-16; P0406.)
6. **AS-40** (action required, 3-D Secure) — **Given** the payment is `PENDING` with `requiresAction: true`, **Then** the page reads the payment (its `clientSecret` is used only in memory, never stored, logged, or put in the URL) and opens the provider's confirmation frame; **When** the buyer completes it, **Then** the flow continues as AS-38; **When** they close or abandon it, **Then** the panel shows "Your bank needs you to confirm this payment." with a **Continue verification** button that reopens it; the hold keeps counting down. (S13 AS-17.)
7. **AS-41** (payment failed) — **Given** the payment becomes `FAILED` (`failureCode` or event reason), **Then** the panel shows the title "Payment didn't go through" and the sentence for the code: `card_declined` "Your card was declined.", `insufficient_funds` "Your card has insufficient funds.", `expired_card` "Your card has expired.", `provider_rejected` or `declined_other` "Your bank didn't accept this payment.", `provider_unavailable` or `provider_canceled` "The payment service had a problem. You weren't charged.", any other or missing code "The payment couldn't be completed."; the order is cancelled by the backend (S10 AS-48), so the panel offers **Buy these items again** (AS-59) and a link to `/orders/{orderId}`; there is no retry button on the same order. (S13 AS-16; S10 AS-48.)
8. **AS-42** (outcome unknown) — **Given** the payment is `UNKNOWN`, **Then** the panel shows "We're confirming your payment with your bank. This can take a few minutes. Please don't pay again.", no **Pay** button exists, and the live and polling rules of AS-39 apply; **When** it settles, **Then** AS-38 (completed) or AS-41 (failed) follows. (S13 AS-23, AS-26.)
9. **AS-43** (order cancelled or refunded) — **Given** the order is `CANCELLED`, **Then** the page shows "This order was cancelled" with the reason sentence from the timeline (`out_of_stock` "Some items sold out.", `payment_failed` "The payment didn't go through.", `hold_expired` "The reservation ended before payment.", `user_cancelled` "You cancelled this order."), **Buy these items again** and **Your orders**; **Given** the order is `CANCELLED` and the order aggregate's payment is `COMPLETED`, `REFUND_PENDING` or `REFUNDED`, **Then** the page adds "Your payment arrived after the reservation ended. It will be refunded automatically." (S10 AS-47; SC-009 of S10); **Given** `REFUNDED`, the page shows "This order was refunded." (S10 AS-36, AS-47, AS-49.)
10. **AS-44** (pay request problems) — **Given** `POST /payments/intents` answers `409 order_not_payable`, **Then** the page re-reads the order and shows the state it reports (`reason` `order_cancelled` → AS-43, `order_paid` → success page, `hold_expired` → AS-43); `409 payment_already_exists {existingPaymentId}` → the page follows that payment (AS-39) instead of showing an error; `422 amount_out_of_range | currency_unsupported`, `422 idempotency_key_*`, `400`, `5xx` → the FR-082 generic alert and the form stays usable with a new attempt; `409 idempotency_in_flight` → as AS-22 (automatic retry, same key); `429` → countdown form of AS-29; `404 order_not_found` while the page itself has just loaded this member's order means the payments side has not yet seen the reservation (S13 AS-12), so the request is retried with the same key every 2 seconds up to 3 times and only then shows "We couldn't start the payment yet. Try again." with **Pay** enabled; `401` → AS-32 flow. (S13 AS-02, AS-06, AS-07, AS-11, AS-12, AS-14.)
11. **AS-45** (stream health) — **Given** the live stream is reconnecting, **Then** a status banner "Live updates paused. Reconnecting…" is shown on the pay and success pages and in the popover (once per page), polling starts after 10 seconds (AS-39), and the banner disappears on reconnect; **When** the stream sends `resync`, **Then** the order and payment are re-read; **When** it refuses the connection (401 or 403), **Then** the session is refreshed once and the stream recreated, and if that fails W01's session-ended flow runs. (S51 AS-16, AS-21; A-13.)
12. **AS-46** (order lags payment) — **Given** the payment is `COMPLETED` and the order is still `RESERVED` (the provider's webhook or the payment event has not been applied yet, S10 AS-41), **Then** the panel shows "Payment received. Confirming your order…" and never "confirmed"; **When** 60 seconds pass without the order becoming `PAID`, **Then** "This is taking longer than usual. You can leave this page; your order will appear in **Your orders** as soon as it is confirmed." is added; polling continues under the AS-39 limits. (S10 AS-41, AS-44, AS-50.)
13. **AS-47** (double submit of the payment) — **Given** the buyer presses **Pay** twice or reloads while the request is pending, **Then** one `POST /payments/intents` result exists: the attempt's key is stored in the tab's session storage like AS-20, a replay answers `202` (and `409 payment_already_exists` is handled by AS-44). (S13 AS-05–AS-07; P0414.)

---

### User Story 4 — The success page tells the truth (Priority: P1)

The page after payment confirms the order only when the system has it as paid, and explains anything else.

**Why this priority**: the browser's redirect is not proof of payment (S10 scope); a false "Order confirmed" is a support incident.

**Independent Test**: visit the success URL of a paid order, of a reserved order and of another member's order.

**Acceptance Scenarios**:

1. **AS-48** (confirmed) — **Given** the order is `PAID` (or later), **Then** the page shows the heading "Order confirmed" (focus moved to it, announced once), "Order #{SHORT}" (the first 8 characters of the id, upper-case), the formatted total, the number of items, the lines by shop, the note "We'll email you a confirmation.", and **View order** (`/orders/{orderId}`) and **Continue shopping** (`searchHref({})`); one `checkout_step` `{step: "success", order_id}` is emitted. Layout per FR-043. (S10 AS-41, AS-58.)
2. **AS-49** (not confirmed) — **Given** the order is `RESERVED` and no payment exists, **Then** the page shows "You haven't paid for this order yet." with **Continue to payment**; **Given** `RESERVED` with a payment in progress or `COMPLETED`, **Then** it shows the AS-38/AS-46 panel; **Given** `CANCELLED` or `REFUNDED`, **Then** it shows the AS-43 copy; in no case does it show "Order confirmed". (S10 AS-41.)
3. **AS-50** (access) — **Given** anonymous, another member's order, an unknown id or a malformed id, **Then** server redirect to sign-in (anonymous) or the same not-found page (the others). (S10 AS-58.)

---

### User Story 5 — A buyer finds, follows and manages their orders (Priority: P2)

History is a keyset-paged list in the URL; detail shows status, timeline, shop slices and payment; the buyer can cancel an unpaid order, pay it, or buy again.

**Why this priority**: it is where the buyer returns, and where notification links land.

**Independent Test**: open `/orders`, page forward, open a detail, cancel an unpaid order.

**Acceptance Scenarios**:

1. **AS-51** (list) — **Given** a member with orders, **When** `/orders` opens, **Then** the heading **Your orders** is followed by the orders newest first, each with "Order #{SHORT}", the placed date, a status badge with text (FR-060), the formatted total, a **View** link to `/orders/{id}`, **Pay now** (link to `/checkout/pay/{id}`) on `RESERVED` orders and **Cancel** on `RESERVED` orders; layout per FR-044. (S10 AS-59.)
2. **AS-52** (empty, loading, error) — **Given** no orders, **Then** "You haven't placed any orders yet." with **Browse products**; loading → skeleton rows with `role="status"` "Loading your orders"; failure → alert "We couldn't load your orders." with **Try again** (FR-082 forms for `429`, `5xx`). (S10 AS-59.)
3. **AS-53** (paging in the URL) — **Given** a next page exists, **Then** an **Older orders** link carries `?cursor=<opaque>` and keeps the same page layout, the browser's back button returns to the previous page and scroll position, a **Newest orders** link (to `/orders`) shows on every page after the first, and nothing else about paging is stored in state; **When** the cursor is rejected (`400 invalid_cursor`), **Then** "This page of orders is no longer available." with **Newest orders**. (S10 AS-59.)
4. **AS-54** (cancel) — **Given** a `RESERVED` order, **When** the buyer presses **Cancel**, **Then** a dialog "Cancel this order?" ("The items go back on sale.") with **Keep order** and **Cancel order** opens with focus on **Keep order**; **When** confirmed, **Then** the button shows "Cancelling…", on `200` the row shows `CANCELLED` and a status toast "Order cancelled" appears, focus returns to the row's **View** link; `409 order_not_cancellable {currentStatus}` → toast "This order can't be cancelled any more (it is now {status text}).", and the row is refreshed; `404 order_not_found` → the row is removed and the list re-read; `429` → countdown form; other problems → FR-082. (S10 AS-40, AS-55.)
5. **AS-55** (detail) — **Given** `/orders/{orderId}` of the member's order, **Then** the page shows "Order #{SHORT}", the status badge, the placed date, the timeline as an ordered list (`{status text}` with its reason sentence and time, oldest first), the lines grouped by shop with each shop's subtotal and shop-order status, the order total, the payment panel (FR-062) and the actions that fit the status: `RESERVED` → **Pay now** and **Cancel**; `CANCELLED` → **Buy these items again**; every line title links to `productHref`. Layout per FR-045. (S10 AS-58.)
6. **AS-56** (detail, partial data) — **Given** the order aggregate returns `payment: null` with an `errors` entry for `payment`, **Then** the rest renders and the payment panel reads "Payment details are unavailable right now." with **Reload**; **Given** `payment: null` and no error, **Then** the panel is absent. (S48; S13 AS-57.)
7. **AS-57** (detail, states) — **Given** the order is loading → skeleton (`role="status"`, "Loading order"); a malformed id, an unknown order and another member's order → the same not-found page; anonymous → server redirect to sign-in with `returnTo=/orders/{id}`; a failed read → alert with **Try again**. (S10 AS-58, SC-008.)
8. **AS-58** (live status) — **Given** an order shown in the list or on the detail page, **When** the stream delivers `order.status {orderId, status, orderVersion}`, **Then** the affected row or page re-reads and shows the new status (a status toast is not shown; a polite announcement "Order #{SHORT} is now {status text}" is made once); events for other orders only refresh their cached entries. (S10 AS-65.)
9. **AS-59** (buy again) — **Given** a `CANCELLED` order, **When** the buyer presses **Buy these items again**, **Then** each line is put back with `PUT /cart/items/{productId}` (quantity = the cart's current quantity plus the order's, capped at 20), the button shows "Adding items…", then the page opens `/cart` with a status toast "Items added to your cart"; lines whose product cannot be added show in an alert "Couldn't add: {titles}." on the cart page; no checkout is started. (S10 AS-03.)
10. **AS-60** (old and deep links) — **Given** `/dashboard/orders`, **Then** it permanently redirects to `/orders`; **Given** the link `/orders/{orderId}` in a notification (S28 AS-01), **Then** it opens the detail page of AS-55. (S28 FR-041.)

---

### User Story 6 — A member reads and manages notifications from the bell (Priority: P2)

The bell shows how many things are new, opens an inbox, marks things read, and learns about new events as they happen.

**Why this priority**: it is how asynchronous outcomes (order confirmed, shipped, payment failed) reach someone who left the page.

**Independent Test**: pay for an order, see the bell count rise, open the inbox, follow the item to the order, see the count drop.

**Acceptance Scenarios**:

1. **AS-61** (bell) — **Given** a signed-in member, **Then** the navbar shows a **Notifications** button (anonymous visitors see none); its accessible name is "Notifications, {n} unread" (or "Notifications"), the badge shows the count (`99+` above 99) and is absent at 0 or while unknown; the count is read from the unread-count endpoint once on mount and on tab focus. (S28 AS-57.)
2. **AS-62** (open the inbox) — **Given** the button, **When** it is pressed (Enter, Space or click), **Then** a non-modal panel titled "Notifications" opens with focus on its first interactive element, showing a skeleton ("Loading notifications", `role="status"`) and then up to 20 items newest first; each item shows title and body as plain text, a relative time (`<time>` with the full date as its title), and an "Unread" marker (visible dot plus screen-reader text) when unread; **Esc** closes the panel and returns focus to the button. (S28 AS-55.)
3. **AS-63** (follow an item) — **Given** an item with a `link`, **When** it is activated, **Then** the item is marked read (count drops at once, rolled back with an alert toast on failure) and the browser goes to the link; a `link` that is not a same-site path (it must start with a single `/`) renders the item as non-interactive text; item text and link are never interpreted as HTML. (S28 AS-58, FR-041; constitution VI.7.)
4. **AS-64** (mark all read) — **Given** unread items, **When** **Mark all as read** is pressed, **Then** every item shows read and the count is 0 at once, announced "All notifications marked as read"; on failure the previous state returns with an alert toast; the button is absent when the count is 0. (S28 AS-60.)
5. **AS-65** (empty, error, limits) — **Given** an empty inbox, **Then** "You're all caught up."; a failed read → "We couldn't load notifications." with **Try again** inside the panel; `429` → "Try again in {wait}."; `401` → W01's session-ended flow; a failed unread-count read leaves the button without a badge. (S28 AS-56, AS-57.)
6. **AS-66** (live arrival) — **Given** the stream delivers `notification {id, type, category, title, body, link, unread, createdAt}`, **Then** the badge increases by one for a new unread item (an `id` already known is ignored), the item is added at the top when the panel has loaded, a polite announcement "New notification: {title}" is made (at most one per 5 seconds), and focus never moves. (S28 FR-040; S51.)
7. **AS-67** (more items) — **Given** a next cursor, **Then** a **Show older** button at the end of the list loads the next 20 into the same list (no duplicates) and keeps focus on the first new item; at the end the button is gone. (S28 AS-55.)
8. **AS-68** (reconnect) — **Given** the stream drops, **Then** the AS-45 banner appears in the panel header (once per page) and, on reconnect or `resync`, the unread count and the loaded first page are re-read; `revoked` closes the stream without a banner. (S51 AS-16.)
9. **AS-69** (layout and keyboard) — **Given** the panel, **Then** at mobile it is as wide as the viewport minus the 16 px gutters, anchored under the header, at most 70% of the viewport tall and scrolls inside; at desktop it is 384 px wide aligned to the button's end; Tab moves through the **Mark all as read** button, the items (each one link or text), **Show older**; the list is a labelled list ("Notifications"); the rest of the page stays reachable by Tab after the panel.

---

### User Story 7 — Everything rides on the same rules (Priority: P3)

Rendering, state, security and accessibility are the same on every W03 screen.

**Why this priority**: they are what keeps the flow correct as it grows; verified once, here.

**Acceptance Scenarios**:

1. **AS-70** (rendering model) — **Given** the built app, **Then** each W03 page has a static shell (heading, layout, skeleton) delivered before any data; request-time reads (cookies, `params`, `searchParams`) sit inside `<Suspense>`; per-member and per-cart data is never cached on the server; `/cart` reads nothing at request time and fetches in the browser; the guarded pages read the session on the server and prefetch their first read into the query cache. (Constitution VI.1, VI.5; Next.js Cache Components.)
2. **AS-71** (state homes) — **Given** the source, **Then**: server data lives only in TanStack Query under keys from `lib/query-keys.ts` (`cart`, `orders`, `payments`, `notifications`); the orders cursor is in the URL; pending, dialog, panel-open and field state is local; the pay step's phases are a `useReducer` with a closed set of phases; the order-attempt key is the only browser-stored value (FR-021); there is no new Context and no global store; no component or hook calls `fetch`, `axios` or `EventSource`. (P0901; VI.3, VI.4.)
3. **AS-72** (browser secrets) — **Given** the app in a browser, **Then** no request from W03 code carries a token set by JavaScript, no token is in storage or any readable cookie, requests are same-origin relative URLs, the provider's `clientSecret` is kept in memory only, and the live stream is one connection per page to `user:<id>` shared by the bell, the order pages and the pay step. (VI.2; S51 A-14; P0512.)
4. **AS-73** (text and money) — **Given** any backend string (product title, shop name, notification title and body, problem `detail`), **Then** it is rendered as text; money is formatted from integer minor units and the currency code of the same object, never from a default; no floating-point arithmetic is applied to money (sums are integer additions of `priceMinor × quantity` for display only). (VI.7; W02 formatMoney.)
5. **AS-74** (accessibility baseline) — **Given** every state of every W03 screen at both widths, **Then** an automated scan reports no serious or critical violation; each page has one `<h1>`; status messages use `role="status"` and errors `role="alert"`; after a client navigation focus moves to the page's `<h1>`; every control is reachable and operable by keyboard with a visible focus ring; targets are at least 44 × 44 px at mobile; animations stop under `prefers-reduced-motion`; colour is never the only carrier of status. (WCAG 2.2 AA.)
6. **AS-75** (analytics) — **Given** the events of FR-090, **Then** `add_to_cart` and `checkout_step` are emitted through W02's `track()` with only the listed props and none when a privacy signal is set. (S39; W02 FR-140–FR-144.)

---

### Edge Cases

- **Double submit, retries and reloads**: AS-18, AS-19, AS-20, AS-21, AS-22, AS-47.
- **Prices and stock changing under the buyer**: AS-23, AS-24, AS-25, AS-26.
- **State drift between tabs and devices**: AS-13 (cart badge on focus), AS-27, AS-28, AS-58, AS-59.
- **Payment after the reservation ended**: AS-36, AS-43.
- **Webhook and payment events arriving late**: AS-46.
- **Outcome unknown at the provider**: AS-42.
- **Abandoned 3-D Secure**: AS-40.
- **Session ending mid-flow**: AS-32, AS-65 (`401` anywhere runs W01's flow).
- **Offline and reconnecting**: AS-07, AS-30, AS-33, AS-45, AS-68.
- **Unauthorized and cross-user access**: AS-14, AS-35, AS-50, AS-57 (not-found, never a 403 form).
- **Guest cart limits and merge**: AS-07, AS-10, AS-11, AS-12.
- **Partial composition (product or payment section failed)**: AS-09, AS-56.
- **Unsafe or oversized backend text**: AS-63, AS-73.
- **Stale cursor**: AS-53.
- **Very long product titles, 50 lines, 20 units, 99+ badges**: layout rules FR-040 to FR-045 (wrap, never overflow); counts AS-13, AS-61.

## Requirements *(mandatory)*

### Functional Requirements

**Cart and add to cart**

- **FR-001**: The cart page reads the cart aggregate (`GET /api/bff/cart`) for the lines with product data and shop names, and the navbar badge and **Add to cart** read the cheap line list (`GET /api/cart`); both are TanStack Query entries under `queryKeys.cart` and every cart write invalidates the whole `queryKeys.cart` prefix. A cart is never read per line (today's one request per line disappears) (AS-03, AS-09, AS-13).
- **FR-002**: Cart writes are `PUT /api/cart/items/{productId}` with `{quantity}`; **Remove** and **Undo** are writes of `0` and of the previous quantity; **+** and **−** change by one within 1–20; writes for one product are serialised in order, the interface updates before the answer and rolls back on failure (AS-04, AS-05, AS-06, AS-07).
- **FR-003**: **Add to cart** adds one unit to the quantity already in the cart (read first), clamps at 20 (disabled with "Maximum 20 in cart" at 20), and shows the toast of AS-02; `<AddToCartButton productId category disabled />` keeps W02's signature (AS-02).
- **FR-004**: Guests and members use the same screens; the guest cookie is HttpOnly and set by the API, so W03 never reads, writes or mentions it; `mergeGuestCart()` returns `{droppedLines}`, stores the last result under `queryKeys.cart.lastMerge()` for the notice of AS-11, and its failure is swallowed (AS-10, AS-11, AS-12).
- **FR-005**: `<CartBadge />` shows the unit count from the lines entry, refetches on tab focus, and never shows a hard-coded number (AS-13).
- **FR-006**: A line with `product: null` is "No longer available" only when the aggregate reports no `products` error; with a `products` error its details read "Details unavailable right now" (AS-08, AS-09).
- **FR-007**: The subtotal is the integer sum of `priceMinor × quantity` over available lines of one currency, shown only when all shown lines share a currency; with several currencies each currency's subtotal is listed and the note "Items in different currencies can't be bought together." is shown (AS-03, AS-73).

**Checkout**

- **FR-010**: `/checkout`, `/checkout/pay/{orderId}`, `/checkout/success/{orderId}`, `/orders` and `/orders/{orderId}` are guarded on the server with `requireServerSession(returnTo)` before any member data is read; the same guard is not the only authorization (the API refuses again, `401` runs W01's flow) (AS-14, AS-35, AS-50, AS-57).
- **FR-011**: Order creation is a server-side function that calls `POST /checkout` with the session, `Idempotency-Key` and `{expectedTotalMinor}` (plus `refCode` only if `checkoutRequestSchema` declares it), and returns a typed result `{ok: true, orderId, replayed}` or `{ok: false, problem}`; it never throws a raw error to the browser (AS-17, AS-34).
- **FR-012**: `expectedTotalMinor` is the estimated total shown on the review screen; the buyer must confirm any other total (AS-23).
- **FR-020**: An order attempt is `{key, expectedTotalMinor, createdAt}` bound to one cart content and one body; the lifecycle rules are AS-19; while a request is in flight the button is disabled and further presses are ignored (AS-18, AS-19).
- **FR-021**: The attempt (and the pay-step attempt, FR-054) is kept in the tab's session storage so a reload reuses the key; it holds no token and no personal data, expires after 24 hours, is deleted on success, on a final outcome and on sign-out (the `BroadcastChannel('auth')` message of W01) (AS-20, AS-47).
- **FR-022**: Each checkout problem has the visible form of the *Problem catalogue* (FR-081); a `202` with `Idempotency-Replayed: true` is a success (AS-21 to AS-31).
- **FR-023**: Going offline disables **Place order** and **Pay** with the banner of AS-33 (AS-33).

**Layout and accessibility (per page)**

- **FR-040** **Cart.** Mobile: one column in this order: heading, notices (merge, partial), shop groups of line cards (image 64 px left; title, price and **Remove** beside it; quantity control and line total below), "Continue shopping", the summary; a bar fixed to the bottom repeats the subtotal and the primary action while the summary is out of view and never covers the focused element. Desktop: two columns, lines (about two thirds, a table with headers Product, Price, Quantity, Total) and a sticky summary card. Landmarks: `<main>`; each shop group is a `<section aria-labelledby>`; lines are a list; the quantity control is a group "Quantity of {title}" with a numeric field labelled the same. Focus order: heading → lines → summary → primary action.
- **FR-041** **Checkout review.** Mobile: heading, progress list, lines (compact), the 15-minute note, total, **Place order** in a bottom bar. Desktop: two columns, lines and notes left, a sticky card with total and **Place order** right. Problem alerts sit directly above the lines, take focus when they appear and keep the buyer's place.
- **FR-042** **Pay.** Mobile: heading, countdown, an order summary collapsed into a disclosure ("Order summary, {n} items, {total}"), card group, status panel, **Pay** at the bottom of the form (not hidden by the on-screen keyboard: the form scrolls). Desktop: two columns, form or status panel left, summary right (sticky); the countdown spans the top. The status panel is one live region (`role="status"`); errors inside it `role="alert"`. Focus: heading → card fields → **Pay**; when a panel replaces the form, focus moves to the panel heading.
- **FR-043** **Success.** One centred column at both widths; the actions stack full-width at mobile and sit side by side at desktop; focus on the `<h1>` on arrival.
- **FR-044** **History.** Mobile: each order is a card (number and date, badge, total, actions in one row that wraps); desktop: a table with columns Order, Date, Status, Total and an actions column; the paging links sit below the list at both widths. Rows use the order id as key; the table has a caption "Your orders".
- **FR-045** **Detail.** Mobile: header, status and actions, timeline, lines by shop, totals, payment panel. Desktop: two columns, lines by shop left; right a sticky card with status, totals, payment panel and actions, and the timeline under it. Timeline is an ordered list; status is text, not colour alone.
- **FR-046** Long titles and shop names wrap; 50 lines and 99+ counts never cause horizontal scrolling at 320 px; no layout depends on hover.

**State, rendering, data flow**

- **FR-050**: The live stream is `GET /api/streams?topics=user:{userId}` as one shared connection per page (ref-counted); events only update or invalidate query entries (`order.status` → orders list and detail; `payment.status` → payments; `notification` → inbox and unread count); `resync` re-reads everything on the page; the polling fallback of AS-39 runs only while the stream is down (AS-39, AS-45, AS-58, AS-66).
- **FR-051**: The pay step's phases are a closed set `idle | tokenizing | submitting | processing | actionRequired | confirming | unknown | failed | completed | expired`, changed only by a pure reducer; transitions follow AS-38 to AS-46 and an impossible pair (such as `submitting` with `failed`) cannot be represented (AS-38 to AS-46).
- **FR-052**: Server components do the guard and the first read; they hand client components only the fields rendered (VI.8); the client reads the same query keys afterwards (AS-70).
- **FR-053**: URL state: the history `cursor` only; the checkout step is the path; nothing else is shareable state (AS-53, AS-71).
- **FR-054**: `POST /payments/intents {orderId, paymentMethodId}` carries one `Idempotency-Key` per pay attempt (new when the payment method token changes), never sends amounts, currency or card fields, and follows the payment by id (AS-38, AS-47).
- **FR-055**: Network calls exist only in `lib/api/{cart,checkout,orders,payments,notifications}.ts` (and the server-only order function); responses are parsed with their `packages/contracts` schemas; hand-written duplicates of those types are not allowed (AS-71; constitution V.2).
- **FR-056**: Order and notification lists use stable ids as keys; list pages never use indexes (AS-71; VI.6).
- **FR-057**: Cache lifetimes in the browser: lines and cart aggregate 0 s stale on focus, orders list 15 s, order detail and payment 0 s while the order is not terminal and 60 s after, notifications unread count 30 s, inbox 30 s. The server caches none of W03's data (AS-70).

**Orders and notifications behaviour**

- **FR-060**: Status text: `PENDING` "Processing", `RESERVED` "Awaiting payment", `PAID` "Paid", `FULFILLING` "Preparing", `SHIPPED` "Shipped", `DELIVERED` "Delivered", `CANCELLED` "Cancelled", `REFUNDED` "Refunded"; the badge always shows the text (AS-51, AS-55).
- **FR-061**: **Cancel** is offered only for `RESERVED` (S10 FR-045); **Pay now** only for `RESERVED`; **Buy these items again** only for `CANCELLED` (AS-51, AS-54, AS-59).
- **FR-062**: The order aggregate's payment section is shown as the payment panel with the status text of S13 (`PENDING` "Processing", `UNKNOWN` "Confirming", `COMPLETED` "Paid", `FAILED` "Failed", `CANCELLED` "Cancelled", `REFUND_PENDING` "Refund on its way", `REFUNDED` "Refunded") and the amount (AS-55, AS-56).
- **FR-063**: The popover's list is an infinite query (`limit` 20, cursor); marking read is optimistic and idempotent (the endpoint is); one `POST /notifications/read` per activation (AS-62 to AS-67).
- **FR-064**: Notification links are followed only when they start with a single `/` and contain no scheme (AS-63).
- **FR-065**: `/dashboard/orders` redirects permanently to `/orders` and the order table leaves the dashboard (AS-60).

**Copy and problems**

- **FR-080**: *Copy catalogue*: the quoted strings of the scenarios and of FR-081/FR-082 are the visible copy; English only; tests assert these strings.
- **FR-081**: *Problem catalogue.* The visible form is chosen by the problem's stable `code`, never by `detail` text:

| Source | Code (status) | Visible form |
|---|---|---|
| S10 cart | `validation_failed` (400) | FR-082 generic (client defect) |
| S10 cart | `cart_line_limit` (422) | toast AS-07 |
| S10 cart/checkout/orders | `rate_limited` (429, `Retry-After`) | "…Try again in {wait}." (W01 FR-041 format); control disabled until then |
| S10 checkout | `cart_empty` (422) | AS-27 |
| S10 checkout | `product_unavailable` (422, `productIds`) | AS-25 |
| S10 checkout | `out_of_stock` (422, `productIds`, `flashSaleId?`) | AS-24 |
| S10 checkout | `mixed_currency` (422) | AS-26 |
| S10 checkout | `price_changed` (409, `currentTotalMinor`, `lines`) | AS-23 |
| S10 checkout | `idempotency_in_flight` (409) | AS-22 |
| S10 checkout | `idempotency_key_reuse` / `_required` / `_invalid` (422) | AS-31 |
| S10 checkout | `checkout_in_progress` (409) | AS-28 |
| S10 checkout | `checkout_unavailable` (503) | AS-30 |
| S11 checkout | `flash_sale_limit_exceeded` (422) | alert "You've reached the purchase limit for this sale item." |
| S11 checkout | `flash_sale_busy` (429/503, `Retry-After`) | alert "This sale is very busy. Try again in {wait}." |
| S11 checkout | `flash_sale_unavailable` (503) | alert "This sale is temporarily unavailable. Try again shortly." |
| S10 orders | `order_not_found` (404) | not-found page, or AS-54 row removal |
| S10 orders | `order_not_cancellable` (409, `currentStatus`) | AS-54 |
| S10 orders / S28 | `invalid_cursor` (400) | AS-53 (orders) / "We couldn't load notifications." with **Try again** (inbox) |
| S13 | `order_not_payable` (409, `reason`) / `payment_already_exists` (409, `existingPaymentId`) | AS-44 |
| S13 | `amount_out_of_range` / `currency_unsupported` (422) | FR-082 generic |
| S13 | `order_not_found` (404) on `POST /payments/intents` | AS-44 (lag: retry 3 times, then "We couldn't start the payment yet. Try again.") |
| S13 | `payment_not_found` (404) | the pay panel re-reads the order and shows its state |
| S28 | `validation_failed` (400) | FR-082 generic |
| any | `401` (`unauthenticated`, `session_expired`, `invalid_token`) | W01's session-ended flow, once |
| any | `5xx` (generic `detail`) and unparseable bodies | FR-082 generic with reference |
| none | network failure (no response) | "You're offline. …" for writes; "We couldn't load …" with **Try again** for reads |

- **FR-082**: The generic form is an alert "Something went wrong. Try again." with "Reference: {requestId}" when the body carries one; `detail` of a `4xx` is shown as a second line only when it is a plain string of at most 200 characters; a `5xx` `detail` is never shown; stack traces and raw bodies are never shown. It is rendered by W01's `<ProblemAlert />` (AS-31, AS-73).

**Analytics**

- **FR-090**: `add_to_cart {product_id, category}` once per successful add; `checkout_step` `{step: "cart" | "review" | "pay" | "success", items: number, order_id?: string}` once per view of that step (cart view, review view, pay view, success view); no totals, titles or personal data (AS-02, AS-17, AS-48, AS-75).

### Key Entities *(include if feature involves data)*

- **Cart view**: the lines of one cart with product data (title, unit price, currency, image, availability) and the shop of each line, plus `droppedLines`; a read model composed by the BFF; never stored by the browser except in the query cache.
- **Order attempt**: the browser's record of one checkout (or pay) attempt: key, expected total, creation time; lives in the tab's session storage for at most 24 hours.
- **Order**: the buyer's purchase as S10 exposes it: status, total, currency, reservation deadline, items (snapshots), shop orders, timeline.
- **Payment**: the buyer's payment for an order as S13 exposes it: status, amount, failure code, action-required flag, and (only on the direct read of the pay step) a one-time client secret kept in memory.
- **Pay phase**: the pay step's closed state set (FR-051).
- **Notification item**: one inbox entry: id, type, category, title, body, link, read, created time; and the live event for it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A signed-in shopper can go from a product page to a confirmed order in at most 8 deliberate actions (add to cart, open the cart, press Checkout, press Place order, fill in or pick the card, press Pay, and at most two more for any sign-in) and under 3 minutes with the sandbox card.
- **SC-002**: Under double click, reload mid-request and two open tabs, exactly 1 order exists per cart in 100% of runs, and the buyer is never shown two different outcomes for one attempt.
- **SC-003**: The page never shows "Order confirmed" for an order that is not paid: 0 occurrences across all states of the success, pay and detail pages.
- **SC-004**: A payment status change reaches the open pay page within 2 seconds when live updates work, and within 7 seconds when only polling works, in 95% of cases; polling never exceeds 30 requests per minute per page.
- **SC-005**: A cart change is visible on screen immediately (no waiting for the server) and is correct again within 1 second after the server's answer in 95% of cases; a failed change is rolled back and explained in 100% of cases.
- **SC-006**: Every problem the flows can meet shows a specific next step or a plain generic message with a reference: 0 occurrences of raw JSON, stack traces, "undefined" or "[object Object]" on screen.
- **SC-007**: Every screen state at 390 px and 1280 px passes the accessibility scan with 0 serious or critical findings, and every journey is completable with the keyboard alone.
- **SC-008**: No W03 screen needs horizontal scrolling at 320 px, with 50 cart lines or 20-unit quantities.
- **SC-009**: Each W03 page shows its title and structure before its data arrives (no blank page), and a guarded page never sends member data to an anonymous visitor.
- **SC-010**: No credential, token or card data is readable by page scripts or stored in the browser by W03; the only stored value is the order-attempt key.

## Assumptions

- Decisions marked `[BREAKING]`, `[CONTRACT]`, `[LOCAL]` are listed one per line in `questions.md`; this spec adopts each default stated there.
- **Browser session**: as W01, the browser holds a BFF session; every same-origin `/api/*` call gets its bearer attached server-side (W01 C-FWD). W03 adds two requirements to that forwarding: the guest `cart` cookie in both directions on cart routes, and unbuffered forwarding of `GET /api/streams`.
- **No cart drawer**: the cart is the `/cart` page; add-to-cart feedback is a toast with **View cart**. (S10's scope line "cart drawer" is answered with "page".)
- **Cart and order data are per member or per visitor**, so nothing of it uses `use cache` on the server; `/cart` is client-fetched behind a static shell.
- **Estimated total**: until S10 offers a priced preview, the review screen sums catalogue prices; seller discounts (S10 AS-24) appear only through the `price_changed` confirmation. This is a known weakness recorded in `gaps.md` (missing endpoint).
- **A card decline cancels the order** (S10 AS-48, S13 allows one payment per order); the buyer retries through **Buy these items again**. A softer rule is a `[CONTRACT]` question.
- **Hosted fields**: the provider's script and frames are loaded only on the pay page; in non-production builds with the sandbox flag a test-card picker replaces them so journeys are deterministic. W07's CSP must allow the provider's hosts on that page only.
- **Stock numbers** are never shown; "Out of stock" is the catalogue's `inStock` flag and the checkout's `out_of_stock` answer.
- **Locale**: English copy only; money uses the browser locale through `formatMoney`; times are shown in the browser's time zone.
- **Order number**: the first 8 characters of the order id, upper-case, is a display label only; links always use the full id.
- **Session storage for the attempt key** is acceptable because the key is a random client value, not a credential (constitution VI.2 forbids tokens there, not this).
- Email confirmation text and delivery belong to S28; the success page only promises it.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web` for `W03` and `web`; `specs/journeys` does not exist): **S10, S13, S28, S35, S39, S51** (domains) and **W01, W02** (web) name W03; **S11, S31** mention it in their `questions.md`. Every obligation they place on W03 is honoured below; differences are `[CONTRACT]` lines in `questions.md`.

### Provides

Exact names; modules are in `packages/web`.

- **Routes**: `/cart` · `/checkout` · `/checkout/pay/{orderId}` · `/checkout/success/{orderId}` (replaces `/checkout/success?orderId=`) · `/orders` with parameter `cursor` · `/orders/{orderId}` (the target of S28's notification link `/orders/<orderId>`) · `/dashboard/orders` (permanent redirect to `/orders`). `{orderId}` that is not a UUID is not found.
- **`<AddToCartButton productId category disabled />`** (`components/add-to-cart-button.tsx`, client): hosted by W02's product page; behaviour AS-02 and FR-003.
- **`<CartBadge />`** (`components/cart/cart-badge.tsx`, client) and **`useCartCount(): number | null`**: for W07's navbar and mobile menu; `null` while unknown.
- **`<NotificationsPopover />`** (`components/notifications/notifications-popover.tsx`, client): for W07's navbar, rendered only for a signed-in member.
- **`mergeGuestCart(): Promise<{ droppedLines: number }>`** (`lib/api/cart.ts`): compatible with W01's `Promise<void>` call site (W01 ignores the value and failure); idempotent (S10 AS-06).
- **`useUserStream`** / **`subscribeUserEvents(handler): () => void`** (`lib/realtime/user-stream.ts`): one ref-counted `EventSource` per page for `user:<id>`, handling `resync`, `revoked`, reconnect and the 401/403 recreate rule; handler receives `{type: 'order.status' | 'payment.status' | 'notification', data}`. Used by the bell, order pages and the pay step; W04/W05 may add their topics to the same connection (`[CONTRACT]` question).
- **`queryKeys`** (`lib/query-keys.ts`) additions: `cart.lines()`, `cart.page()`, `cart.lastMerge()`; `orders.list({cursor})`, `orders.detail(id)`; `payments.detail(id)`; `notifications.unreadCount()`, `notifications.inbox()`. Removed: the duplicate constants `CART_QUERY_KEY` and `ORDERS_QUERY_KEY`; `cart.all` and `orders.all` remain as invalidation prefixes only.
- **Events emitted** (S39): `add_to_cart {product_id, category}`; `checkout_step {step: 'cart' | 'review' | 'pay' | 'success', items, order_id?}`.
- **Behavioural guarantees**: one order per attempt under any retry pattern; "confirmed" only for `PAID`; no W03 request carries a token from JavaScript; every W03 write that the backend requires sends `Idempotency-Key` and the shared CSRF header; a `401` from a W03 call runs W01's session-ended flow once; every list uses stable keys.

### Requires

- **S10** (`orders`), all under `/api`: `GET /cart` → `cartSchema` `{lines: [{productId, quantity, addedAt}], droppedLines}` (anonymous allowed); `PUT /cart/items/{productId}` `{quantity: 0..20}` → `200 cartSchema`; `POST /cart/merge` (session) → `200 cartSchema` with `droppedLines`; `POST /checkout` (session; `Idempotency-Key`; body `{expectedTotalMinor?}`) → `202 {orderId, status: "RESERVED", totalMinor, currency, reservedUntil}` with `Location`, `Idempotency-Replayed` on replay, problem codes as FR-081; `GET /orders?limit&cursor` → `{items: [{id, status, totalMinor, currency, createdAt}], nextCursor}`; `GET /orders/{orderId}` → `orderSchema` `{id, status, totalMinor, currency, reservedUntil, createdAt, items: [{productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders: [{id, shopId, subtotalMinor, status}], timeline: [{status, reason, at}]}`; `POST /orders/{orderId}/cancel` → `200 orderSchema` (`409 order_not_cancellable {currentStatus}`, `404 order_not_found`, `429`). Realtime: topic `user:<userId>`, event `order.status {orderId, status, orderVersion}`. **Additive asks** (`[CONTRACT]`): `refCode?` in `checkoutRequestSchema`; `reservedUntil: string | null` in the order list item; a priced preview (see `gaps.md`).
- **S13** (`payments`): `POST /payments/intents` (`Idempotency-Key`; `{orderId, paymentMethodId}`) → `202 {paymentId, orderId, status: "PENDING", amountMinor, currency, createdAt}`; `GET /payments/{paymentId}` → `{id, orderId, status: 'PENDING' | 'UNKNOWN' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REFUND_PENDING' | 'REFUNDED', amountMinor, currency, failureCode, requiresAction, clientSecret, version, createdAt, updatedAt}`; problems `order_not_payable {reason}`, `payment_already_exists {existingPaymentId}`, `amount_out_of_range`, `currency_unsupported`, idempotency and rate-limit codes; realtime event `payment.status {paymentId, orderId, status, version}` on `user:<userId>`; read policy 120 per minute.
- **S28** (`notifications`): `GET /notifications?limit=1..50&cursor` → `{items: [{id, type, category, title, body, link, read, createdAt}], nextCursor}`; `GET /notifications/unread-count` → `{unread}`; `POST /notifications/read` `{ids: string[1..100]}` or `{all: true}` → `{unread}`; realtime event `notification {id, type, category, title, body, link, unread, createdAt}` on `user:<userId>`; `link` is a relative path (S28 FR-041).
- **S51** (`realtime`): `GET /api/streams?topics=user:<id>`; frames `event: <type>` with `data: {"topic","data"}`; in-band `resync {reason}` and `revoked`; `Last-Event-ID` replay; refused connections (401/403) are final for the browser and are recreated by W03.
- **S48** (BFF): same-origin `/api/*` forwarding with the bearer attached (W01 C-FWD), now also (a) relaying the guest `cart` cookie to `/api/cart*`, `/api/bff/cart` and relaying the API's `Set-Cookie` for it back, (b) forwarding `GET /api/streams` as an unbuffered, uncompressed event stream; and **two new aggregates** (IX.7 R2, per-call budgets, partial sections):
  - `GET /api/bff/cart` (anonymous allowed) → `cartPageResponseSchema` `{lines: [{productId, quantity, addedAt, product: {title, priceMinor, currency, imageUrl: string | null, inStock: boolean} | null, shop: {id, name} | null}], droppedLines: number, errors: [{section: 'products' | 'shops', code, retryable}]}`; a line whose product is hidden, archived or unknown has `product: null`; if the product call fails every line has `product: null` and `errors` has a `products` entry.
  - `GET /api/bff/orders/{orderId}` (session) → `orderPageResponseSchema` `{order: orderSchema, payment: {id, status, amountMinor, currency, failureCode, requiresAction, version, updatedAt} | null, errors: [{section: 'payment', code, retryable}]}`; `404 order_not_found` for an unknown or foreign order; the payment is the latest payment of the order (S13 `GET /payments?orderId=`; `clientSecret` is never included).
- **W01**: `requireServerSession(returnTo)`, `loginHref(returnTo)`, `useAuth()` (read-only), `problemFromError`, `<ProblemAlert />`, `csrfHeaders()`, the session-ended flow, invalidation of non-session queries after sign-in and cache emptying after sign-out, `BroadcastChannel('auth')`; W01 calls `mergeGuestCart()` once per sign-in.
- **W02**: `productHref`, `searchHref`, `track`, `newIdempotencyKey`, `getRefCode`, `formatMoney(minor, currency)`, the product page hosting `<AddToCartButton />` with `category`.
- **W07**: mounts `<CartBadge />` and `<NotificationsPopover />` in the navbar and the cart link in the mobile menu, provides the skip link, `<main>`, global error and not-found pages, and a CSP that allows the payment provider's script, frame and connect hosts on `/checkout/pay/*` only.
- **S39**: same-origin `POST /api/events` accepting the events of FR-090 (`checkout_step` props flat strings, numbers).
- **S11**: the extra checkout problem codes of FR-081.
- **`packages/contracts`**: schemas `cartSchema`, `setCartLineRequestSchema`, `checkoutRequestSchema`, `checkoutResponseSchema`, `orderSchema`, `orderListItemSchema`, `orderPageSchema`, `paymentAcceptedSchema`, `paymentSchema`, `notificationPageSchema`, `notificationItemSchema`, `unreadCountSchema`, `markReadRequestSchema`, `problemSchema`, and the new `cartPageResponseSchema`, `orderPageResponseSchema` (the package has no source today).
- **Configuration**: `API_URL`/`BFF_URL` (server only), `NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY` (public by nature), `NEXT_PUBLIC_PAYMENTS_SANDBOX` (non-production only).

## Pattern coverage (pattern-map rows whose Specs column names W03)

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0414 Idempotency keys (replay, in-flight 409, different-body 422, TTL) | FR-011, FR-020, FR-021, FR-022, FR-054 | AS-17, AS-18, AS-19, AS-20, AS-21, AS-22, AS-31, AS-38, AS-47 |
| P0901 Server vs client state; Context vs reducer vs store; URL state | FR-001, FR-050, FR-051, FR-052, FR-053, FR-055, FR-056, FR-057 | AS-04, AS-39, AS-53, AS-58, AS-70, AS-71 |
