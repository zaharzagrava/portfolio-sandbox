# fin-14. PCI DSS scope reduction: tokenization and hosted fields

*Fintech pack · Security · Medium*

## The question

Tenants pay rent by card in our web app and React Native app. Today the card form posts to our API, which forwards the card number to the PSP. Security says that puts most of our platform in PCI DSS scope. How do you reduce scope, and where must card data never touch?

**Then:** A PMS partner wants to send us tenants' saved card numbers through their API so we can charge them. And support wants to see full card numbers to debug declines. What do you say?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Are we a merchant on the PSP's platform product, or a service provider processing for landlords? → assume: merchant/platform on a PSP's connected-accounts product. A service provider validates differently (SAQ D for service providers or an on-site assessment, depending on volume and card brand rules).
- Card transactions per year? → assume: 1-2M. Merchant level is set by card-brand thresholds; the acquirer decides what validation it accepts.
- Does the PSP offer hosted fields (iframes), a hosted payment page, mobile SDKs, saved payment methods? → assume: yes.
- Any card entry outside the apps (phone, back office, partners)? → assume: support sometimes takes card payments by phone.
- Which PCI DSS version? → assume: v4.0.1, the current version after v4.0 was retired at the end of 2024.

## Design

1. **Card entry goes browser → PSP.** Use the PSP's hosted fields: iframes served from the PSP's domain. Our JavaScript never reads the card number; we get back a payment-method token (`pm_...`).
2. **Mobile:** the PSP's native SDK collects the card and returns a token. Same rule.
3. **What we store:**
```sql
CREATE TABLE payment_methods (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  psp text NOT NULL, psp_payment_method_id text NOT NULL,
  brand text, last4 char(4), exp_month int, exp_year int,
  psp_fingerprint text            -- PSP-specific card fingerprint, for "same card" checks
);
```
No PAN, no CVV. CVV (sensitive authentication data) can't be stored after authorization, even encrypted.
4. **Charging:** server calls the PSP with the token and an idempotency key; 3DS runs inside the PSP's SDK.
5. **What stays in scope:** the pages that host the iframe (a compromised page can replace the iframe with a fake form), the build and CDN pipeline that serves them, and the people/systems that can change them. Controls: a minimal payment page bundle (no tag manager, no analytics scripts), CSP with `script-src` and `frame-src` allowlists, pinned dependencies, change monitoring on that page.
6. **Validation:** with all card entry in PSP iframes or a redirect and no card data on our systems, a merchant can usually validate with **SAQ A**. A form our page builds and posts directly to the PSP is **SAQ A-EP**. Card data reaching our servers means **SAQ D**. Requirement details change between SAQ revisions (the 2025 SAQ A revision changed how payment-page script requirements apply), so check the current text with the acquirer.
7. **Keep it true:** PAN detector (13-19 digits passing Luhn) on logs, support tickets and request bodies; alert, don't just redact.
8. **Phone payments:** agent sends the tenant a pay link by SMS instead of typing card numbers.

## Deep dives

**1. Hosted fields vs redirect vs our own form + PSP JS.**
Problem: UX vs scope.
Approach: hosted fields: our page layout, PSP-owned inputs, SAQ A-eligible in most setups.
Rejected: our own inputs with PSP JS tokenizing in the page: our page's script touches the PAN, so SAQ A-EP and much more work. Full redirect to a hosted page is the smallest scope but a worse checkout; keep it as a fallback.

**2. Partner sends card numbers (twist, part 1).**
Problem: accepting PANs on our API puts the API, its queues, logs, DB and the people who operate them in scope.
Approach: refuse PANs. Options: a PSP-to-PSP card data migration (the partner's PSP exports to ours over a PCI-compliant channel; we receive only a mapping old ref → our token), or tenants re-enter cards via our hosted fields from a pay link.
Rejected: "we encrypt it on arrival". A system that receives and can decrypt card data stays in scope; encryption reduces risk, not scope.

**3. Support wants full card numbers (twist, part 2).**
Problem: debugging declines.
Approach: full PAN is not needed. Support sees brand, last 4, expiry, PSP fingerprint, the PSP decline code and 3DS outcome. Deeper investigation happens in the PSP dashboard with named, role-limited accounts.
Rejected: a "reveal card" button through a PSP API. Even if a PSP allowed it, it would bring support tooling into scope.

## Traps

- **"Tokenized, so we're out of scope"**: the page hosting the iframe and its script supply chain remain in scope.
- **Holding CVV "temporarily" in Redis or a queue for retries**: sensitive authentication data may not be stored after authorization.
- **Request-body logging middleware** in front of any endpoint that once received cards: PANs end up in CloudWatch.
- **Treating bank account numbers as PCI data**: PCI DSS covers card data. Bank details are protected by other rules (privacy law; in the US, Nacha requires large ACH originators to render stored account numbers unreadable), with different controls.
- **"SAQ A means no security work"**: it's a smaller set of requirements, not zero, and the hosting page still needs protection.

## Say it (60–90 s)

The goal is that card numbers never touch our servers, our logs or our JavaScript. On the web I'd use the PSP's hosted fields, which are iframes served from the PSP's domain, so the card goes from the browser straight to the PSP and we get back a token. On mobile, the PSP's native SDK does the same. Our database stores only the token, brand, last four, expiry and the PSP's fingerprint; never the PAN, and never the CVV, which can't be stored after authorization at all. Charges are server-to-server with the token and an idempotency key. What stays in scope is the page that hosts the iframe, because a compromised page can swap in a fake form, so that page gets a minimal bundle, a strict CSP and change monitoring. With that setup a merchant can usually validate with SAQ A instead of SAQ D, though the acquirer has the final word. I'd also add a PAN detector on logs and support tickets. If a partner wants to send us card numbers, I'd say no and do a PSP-to-PSP migration instead, and support gets last four and decline codes, not full numbers.

## Follow-ups

**Q:** Doesn't the backend that charges tokens need PCI controls?
**A:** Tokens we can't reverse aren't cardholder data, so that backend is normally outside the cardholder data environment. It still can move money, so it gets strong access control for fraud reasons.

**Q:** How do you stop someone adding a script to the payment page?
**A:** Separate small bundle for that page, CSP with nonces and an allowlist, pinned and reviewed dependencies, SRI on third-party scripts, and a monitor that alerts when the page's scripts or headers change.

**Q:** What changes if we become a payment facilitator?
**A:** We become a service provider: stricter validation (often an on-site QSA assessment at high volume), sub-merchant onboarding duties. The card-entry design stays the same.

</details>

## Theory in the notes

- [05-security/01-web-security-xss-csrf-csp.md](../../05-security/01-web-security-xss-csrf-csp.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
