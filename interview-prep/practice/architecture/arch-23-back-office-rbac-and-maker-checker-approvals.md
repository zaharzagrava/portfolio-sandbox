# arch-23. Back-office RBAC and maker-checker approvals

*Security · Medium*

## The question

Ops, support and finance (about 40 people) use an internal admin tool to look up tenants, issue refunds, change landlord payout bank accounts and release held payouts. Design the access control. Refunds above ₪5,000, every payout-account change and every payout release must be approved by a second person.

**Then:** Finance wants to approve 300 payouts in one click on payout day, and on-call needs emergency access at 3 a.m. when no approver is awake.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Identity provider? → assume: Google Workspace or Okta SSO with MFA enforced there; no local passwords.
- Data scope per person? → assume: most staff see all landlords with bank data masked; a few contractors are limited to one region.
- Are approval rules configurable? → assume: yes, in a config table; changing the rules is itself an approval-required action.
- Approval expiry? → assume: 24 h, then the request expires.
- Who executes the action: the approver's HTTP request or a job? → assume: a background job after approval.
- Any amount where even two people aren't enough? → assume: above ₪200,000, two approvers from finance.

## Design

1. **AuthN:** OIDC SSO, MFA at the IdP, IdP groups mapped to roles, group sync so offboarding removes access within minutes. Admin sessions are short (e.g. 8 h); sensitive actions require a fresh re-auth.
2. **RBAC:** permissions are verbs (`refund.request`, `refund.approve`, `payout_account.change.request`, `payout_account.change.approve`, `payout.release.approve`, `pii.reveal`). Roles bundle permissions. A backend guard on each endpoint checks them; the UI only hides buttons.
3. **Maker-checker table:**
```sql
CREATE TABLE approval_requests (
  id uuid PRIMARY KEY, action text NOT NULL,
  payload jsonb NOT NULL, payload_hash text NOT NULL,
  amount_minor bigint, currency char(3),
  requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired|executed|failed
  decided_by uuid, decided_at timestamptz, expires_at timestamptz NOT NULL,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
```
4. **Flow:** maker submits → a policy function decides if approval is needed (action, amount, thresholds) → `pending`. The checker sees the exact payload, a diff (old vs new bank account), and risk hints (account changed recently, login from a new country, landlord's first payout). Approve is one guarded statement:
`UPDATE approval_requests SET status='approved', decided_by=$me, decided_at=now() WHERE id=$1 AND status='pending' AND expires_at > now() AND payload_hash=$shownHash`.
5. **Execution:** a job runs the action with idempotency key = request id, re-validates (refund ≤ refundable remainder, payout still held), sets `executed` or `failed`.
6. **Payloads are immutable.** Any change is a new request; the hash the checker saw is the hash executed.
7. **Payout account change:** after approval, payouts to the new account are held 48 h and the landlord is notified on the old, already-verified contact channel.
8. **Audit:** request, decision, execution and every `pii.reveal` go to the audit log.

## Deep dives

**1. Where separation of duties is enforced.**
Problem: UI checks are bypassable; app checks can have bugs.
Approach: three layers: the endpoint guard (permission), the policy function (thresholds), and the DB `CHECK (decided_by <> requested_by)`. Also block approvals where the approver is linked to the beneficiary (e.g. their own landlord account).
Rejected: "approver must be a different role" only. A person with both roles could approve their own request.

**2. Batch approval (twist, part 1).**
Problem: 300 single approvals become rubber-stamping.
Approach: one request of action `payout_batch.release` with the payout id list, count, total per currency and a hash of the exact set. Outliers (first payout to a new account, amount > 3× the landlord's usual, account changed in the last 30 days) are excluded from the batch and need individual review. The checker approves the summary; execution releases exactly that set.
Rejected: an "approve all" button over 300 rows. A request added after the page loaded would be approved unseen.

**3. Break-glass (twist, part 2).**
Problem: an emergency with no second person available.
Approach: split actions by direction of risk. Actions that reduce risk (pause payouts, freeze an account, block a card method) are single-person and always allowed for on-call. Actions that move money out keep maker-checker; break-glass for those is a time-boxed elevation (1 h) with a reason and incident id, pages security, and is reviewed next day.
Rejected: a shared emergency admin account. No attribution, and it tends to stay in use after the emergency.

## Traps

- **Permission checks only in the frontend.**
- **Approving a request that changed after the checker looked at it** (no immutability or hash check).
- **Executing the PSP call inside the approve HTTP request**: double-click = double refund without an idempotency key.
- **Admins editing roles or thresholds without approval**: the control can switch itself off.
- **Sending the "bank account changed" notice to the new contact details**: the attacker receives it.
- **Shared accounts or long-lived admin sessions**: no attribution, stolen-session risk.

## Say it (60–90 s)

Staff log in with SSO and MFA from our identity provider, and groups there map to roles in the admin tool, so offboarding is one place. Permissions are verbs like refund.request, refund.approve and payout.release.approve, checked by a guard on every backend endpoint, not just in the UI. Maker-checker is a table of approval requests: the action, the exact payload and its hash, the amount, who requested it, and a status with an expiry. A policy function decides when approval is needed. The checker sees the payload, a diff for bank account changes and risk hints, and approval is one guarded update that requires the request to be pending, unexpired and unchanged, plus a database check that the approver isn't the requester. Execution is a separate job with the request id as idempotency key, and it re-validates before acting. For payout day, finance approves one batch request with counts, totals and a hash of the exact set, and outliers are pulled out for individual review. For emergencies, actions that reduce risk, like pausing payouts, are single-person; money-out actions keep two people, or a time-boxed, audited break-glass.

## Follow-ups

**Q:** RBAC or ABAC?
**A:** RBAC for who can do what; attributes (amount, region, relationship to the beneficiary) as conditions in one policy function. A policy engine (OPA, Cedar) only when the rules outgrow code review.

**Q:** What if the maker and checker collude?
**A:** You can't prevent it, only limit and detect it: per-period limits, anomaly reports, holds on new bank accounts, landlord notification, regular access reviews.

**Q:** How do you test it?
**A:** Unit tests on the policy table, an integration test that the DB rejects self-approval and stale hashes, and a quarterly access review of who holds approve permissions.

</details>

## Theory in the notes

- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
