# fin-10. KYC with an async vendor and manual review

*Fintech pack · Compliance · Easy*

## The question

Before a landlord can receive payouts, we must verify their identity, or for a company, the company and its owners. We use a KYC vendor: the landlord completes ID + selfie in the vendor's SDK, the result arrives by webhook minutes to days later, and about 10% go to manual review. 3,000 new landlords a month. Design the flow and the data model.

**Then:** Two weeks after approval, a landlord's name matches a newly added sanctions-list entry. Separately, a company landlord adds a new 30% owner. What happens?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Who is legally responsible for KYC: us or the PSP? → assume: us, through our partner bank or license. If the PSP's platform product (e.g. Stripe Connect) verifies connected accounts, much of this moves to them.
- Individuals and companies? → assume: both. Companies need beneficial owners; in the US the FinCEN CDD rule covers each owner with ≥ 25% plus one control person. Thresholds differ by country.
- What is blocked until verified? → assume: payouts only. Onboarding continues and tenant payments are accepted and held.
- Ongoing monitoring? → assume: sanctions rescreening whenever lists change (vendor service or daily batch).
- Retention? → assume: required by AML law for years after the relationship ends; the period depends on the jurisdiction.
- Review SLA? → assume: 1 business day.

## Design

```sql
verification_subjects(id, landlord_id, type,        -- person | business
  parent_subject_id NULL, role,                      -- owner | control_person | business
  legal_name, country, ownership_pct numeric NULL)
verifications(id, subject_id, vendor, vendor_session_id UNIQUE,
  status,                                            -- created|pending|approved|rejected|needs_review|expired
  risk_flags jsonb, decided_by,                      -- vendor | reviewer:<id>
  reason, decided_at)
verification_events(vendor_event_id UNIQUE, verification_id, raw jsonb, received_at)
landlord_capabilities(landlord_id PRIMARY KEY, payouts_enabled bool, blocking_reasons text[], updated_at)
```

1. **Start:** backend creates a vendor session with our verification id as reference; frontend runs the vendor SDK with a short-lived token. Documents and images stay with the vendor.
2. **Result:** signed vendor webhook → stored in `verification_events` (dedupe by event id) → worker fetches the result from the vendor API (the webhook only says "something changed") → guarded state transition.
3. **Decision:** vendor result + our rules (country supported, name matches the payout bank account holder, business registry match for companies) → `approved`, `rejected` or `needs_review`.
4. **Manual review:** back-office queue ordered by SLA; reviewer opens the vendor's case view; decision with reason; overriding a vendor rejection needs a second reviewer.
5. **Capabilities:** recomputed on every verification change: `payouts_enabled` = all required subjects approved + sanctions clear + bank account verified. Payouts read only this.
6. **Sweeper:** sessions `pending` for > 1 h → poll the vendor; started but abandoned sessions → reminder emails.
7. **Ongoing:** sanctions monitoring on every approved subject; ID expiry dates trigger re-verification.

## Deep dives

**1. Sanctions hit after approval (the twist).** Monitoring flags the subject → verification `needs_review`, `payouts_enabled = false` immediately, funds held. Most name-only hits are false positives; the reviewer compares date of birth, nationality and address. A true match goes to compliance, which decides on blocking, reporting and the customer relationship under the applicable sanctions regime (OFAC in the US, other lists elsewhere). Don't tell the landlord about any suspicious-activity report; tipping-off rules forbid it. Rejected: one-time screening at onboarding.

**2. New 30% owner (the twist).** Above the 25% threshold under the US CDD rule, so a new owner subject is created and needs verification. Policy, set with compliance: payouts continue for a short grace period (e.g. 14 days) while the owner verifies, then stop. Rejected: ignoring ownership changes after onboarding.

**3. PII minimization.** We store the result, the vendor reference and the minimum fields needed; images stay at the vendor. Rejected: copying every document into our S3 "just in case" (bigger breach surface, harder deletion).

**4. Async by design.** The UI shows "verification in progress"; nothing blocks on the vendor. Rejected: the frontend waiting on a synchronous result.

## Traps

- Trusting the SDK's client-side "completed" callback as approval.
- Storing ID images and selfies in our database.
- A single `is_verified` boolean on the landlord: no history, no per-owner status, no reasons.
- Blocking all onboarding on KYC when only payouts need it.
- Verifying once and never rescreening.
- Telling a customer they are the subject of a suspicious-activity report.

## Say it (60–90 s)

I model subjects, the person or the business and each beneficial owner, and one verification per vendor session with a status, flags and who decided. The backend creates the vendor session with our id as reference, and the landlord does ID and selfie in the vendor's SDK; images stay at the vendor. The vendor's signed webhook goes into an events table deduped by event id, and a worker fetches the actual result from the vendor API before making a guarded state change. Our rules on top of the vendor result decide approved, rejected or needs review. Review is a back-office queue with reasons, and overriding a rejection needs a second reviewer. Everything feeds one derived capability, payouts enabled, which is the only thing the payout run checks; onboarding and tenant payments continue meanwhile. A sweeper polls stuck sessions. For the twist: a sanctions hit disables payouts immediately and goes to review, because most name hits are false positives. A new 30% owner crosses the US 25% threshold, so that person must verify within a grace period, or payouts stop.

## Follow-ups

**Q:** The vendor is down for a day.
**A:** Session creation retries; landlords continue onboarding; payouts wait. A second vendor only if volume or SLA requires it.

**Q:** A webhook arrives for a session we never created.
**A:** No matching `vendor_session_id` → reject, alert. The signature check would normally stop it first.

**Q:** How do you audit reviewers?
**A:** Every decision is an immutable row with reviewer id, reason and time; a sample is re-reviewed by compliance.

</details>

## Theory in the notes

- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
