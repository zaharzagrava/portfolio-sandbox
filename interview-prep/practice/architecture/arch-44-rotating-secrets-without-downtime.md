# arch-44. Rotating secrets without downtime

*Security · Easy*

## The question

"We have Postgres passwords used by 6 services, HMAC secrets for webhooks we receive from 3 PMS partners and send to 50 partners, and PSP API keys. Security wants all of them rotated every 90 days, and within an hour on demand after a leak, with zero downtime. How?"

**Then:** "A developer pasted the production PSP secret key into a public Slack channel. Go."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Where do secrets live? → assume: AWS Secrets Manager; services on ECS read them through an SDK cache, not baked into images.
- Who controls each side? → assume: DB both sides ours; inbound HMAC: the partner signs, we verify; outbound HMAC: we sign, partners verify; PSP keys: the PSP issues.
- Can services restart for a rotation? → assume: yes (rolling), but refresh without restart is preferred.
- Audit? → assume: CloudTrail logs secret reads; we need to know who could read what.
- Does the PSP allow two active keys? → assume: yes; many PSPs support either several keys or a "roll" with a delayed expiry of the old one. Check per provider.

## Design

**One rule for every secret: a period where old and new are both valid, then revoke old once nothing uses it.**

**1. Postgres passwords: Secrets Manager "alternating users" rotation.**
- Two login roles, `app_a` and `app_b`, both members of `app_role`, which owns the grants.
- Rotation sets a new password on the *inactive* user and moves `AWSCURRENT` to it. The other user's password stays valid until the next rotation. (This strategy needs a separate admin secret that can change the users' passwords.)
- Services re-read the secret every ~5 min via a caching client, and immediately once on an auth error. Pools close connections after a max lifetime (e.g. 30 min) so new connections pick up the new user.

**2. Inbound HMAC (partner signs):** store up to two secrets per partner and verify against both. Log which one matched (`last_matched_at`). Retire the old one when it hasn't matched for 7 days.

**3. Outbound HMAC (we sign):** during the overlap, send a signature for each active secret (e.g. `Signature: t=...,v1=<new>,v1=<old>`; Stripe does this when you roll its webhook secret). Partners accept any valid one. Drop the old after the announced window.

**4. PSP keys:** create the new key at the PSP, store it, let services pick it up, check the old key's last-used time (where the PSP shows it), then expire it.

```sql
webhook_secrets(partner_id, direction text,         -- in | out
                secret_arn text, status text,        -- active | retiring | revoked
                created_at, retire_after, last_matched_at)
```

**Ops:** rotation is a scheduled, automated job (Secrets Manager rotation Lambda for DB; our job for HMAC). Alerts on rotation failure and on auth errors after a rotation. Nothing logs secret values.

## Deep dives

**1. Why single-user rotation causes errors.** If the same DB user's password changes in place, any service that read the old value fails on new connections until it refreshes. With alternating users the old credentials keep working through the overlap. Alternative: IAM database authentication (15-minute tokens, no stored password). It removes the password, but every new connection needs a freshly generated token, AWS documents extra memory needed on the DB instance for it (300-1000 MiB), and its guidance on connection rates has changed over time, so check current docs before using it with high connection churn. Behind RDS Proxy the churn problem mostly goes away.

**2. Knowing that nobody uses the old secret.** You can't revoke safely without usage data: `last_matched_at` for inbound HMAC, `pg_stat_activity.usename` for DB users, PSP dashboards for keys. Rejected: "wait 30 days and hope".

**3. Emergency rotation trades availability for safety.** For a leaked secret that can move money, there's no overlap: revoke now, accept a few minutes of errors while services refresh. The automation for routine rotation is what makes the emergency path fast.

## Traps

- Rotation by replacing the secret in place: every client fails until it reloads.
- Secrets in environment variables fixed at deploy, with no refresh path: rotation means a full redeploy, and the hour-long SLA becomes hard.
- Keeping the old secret valid forever "in case": the rotation achieved nothing.
- One HMAC secret shared by all partners: one leak forces 50 partners to rotate.
- Logging secrets in error messages or request dumps.

## Say it (60–90 s)

The rule for every secret is overlap: for a while both old and new are valid, every consumer moves to the new one, I verify that nobody uses the old one, then I revoke it. For Postgres I use Secrets Manager's alternating-users rotation: two login roles with the same grants, and each rotation changes the password of the inactive one and makes it current, so the old credentials keep working until the next rotation. Services read secrets through a cache that refreshes every few minutes and once more on an auth error, and connection pools recycle connections so they pick up the new user. For webhooks we receive, I keep two secrets per partner, verify against both, and log which one matched, so I know when the partner has switched. For webhooks we send, I sign with both secrets during the window and partners accept either. PSP keys work the same way: create a new key, deploy, check the old key's last use, expire it. All of it is automated, which matters most for the emergency case. If the PSP key leaks in Slack, I revoke it right away without overlap and accept a few minutes of errors, check the PSP logs for calls we didn't make, and then ask why a developer could read a production key at all.

## Follow-ups

**Q:** Then: the PSP key is in a public Slack channel. Steps?
**A:** Treat it as compromised: roll it at the PSP with immediate expiry, put the new key in Secrets Manager, force a refresh. Check the PSP's request logs since the paste for calls not from our IPs. Deleting the message doesn't un-leak it. Afterwards: restricted keys with minimum permissions, IP allowlists where the PSP supports them, and no human read access to production keys.

**Q:** Do you rotate KMS keys the same way?
**A:** No. KMS automatic rotation keeps old key material for decrypting, so nothing needs re-encrypting; with envelope encryption only data keys are wrapped by it.

**Q:** Is 90 days the right interval?
**A:** The interval matters less than being able to rotate fast and safely. Once rotation is automated, 90 days is routine and the 1-hour emergency SLA is realistic.

</details>

## Theory in the notes

- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
