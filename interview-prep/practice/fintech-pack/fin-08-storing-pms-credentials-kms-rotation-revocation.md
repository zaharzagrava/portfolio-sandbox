# fin-08. Storing PMS credentials: KMS, rotation, revocation

*Fintech pack · Security · Easy*

## The question

Each property manager connects their PMS account to us, either with OAuth (we get access and refresh tokens) or by pasting an API key. We have 6,000 connected accounts and integration workers make about 50 PMS calls per second. Design how we store, use, rotate and revoke these credentials.

**Then:** A developer accidentally logged a decrypted API key for one customer to CloudWatch. What do you do, and what in your design limits the damage?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Credential types per PMS? → assume: OAuth2 authorization code for two PMSs (refresh tokens may rotate), static API keys for one.
- Who needs plaintext? → assume: only the integration workers. The web app only stores new credentials during the connect flow.
- Compliance target? → assume: SOC 2; auditors want to see who accessed which secret and when.
- Can the PMS issue a second key in parallel? → assume: yes for API keys, so rotation can overlap.
- Does the PMS support token revocation? → assume: OAuth revocation endpoint for one PMS; for API keys the customer revokes in the PMS UI.
- Multi-region? → assume: one region, with backups.

## Design

**Storage: envelope encryption in Postgres.** One Secrets Manager secret per account would cost about $2,400/month at $0.40 per secret and adds an API call per read; it fits a handful of platform secrets, not 6,000 customer credentials.
```sql
pms_credentials(id, account_id, partner_id, kind,   -- oauth | api_key
  version int, ciphertext bytea, encrypted_data_key bytea, kms_key_arn text,
  status,                                           -- active | rotating | revoked
  access_expires_at timestamptz, created_at, UNIQUE (account_id, version))
```
**Encrypt:** KMS `GenerateDataKey` → AES-256-GCM locally → store ciphertext + the encrypted data key. **Encryption context** `{account_id, partner_id}` is bound to the ciphertext: KMS refuses to decrypt with a different context, so a row copied to another account fails, and every `Decrypt` in CloudTrail shows which account it was for.

**Access:** the key policy gives `kms:Decrypt` only to the integration worker's IAM role; the web app role gets `GenerateDataKey`/`Encrypt` only.

**Use:** workers decrypt on demand and cache plaintext in memory for ≤ 5 minutes, which keeps KMS calls well under 50/s and within KMS request quotas. Plaintext lives in a `Secret` wrapper whose `toString`, `toJSON` and `util.inspect` return `[redacted]`; the logger redacts `authorization`, `apiKey`, `token` paths.

**OAuth refresh:** under a per-account row lock (single flight), because rotating refresh tokens break if two workers refresh at once. Write the new version, then mark the old one.

**Rotation:** API key: the customer pastes a new key → version 2 `active`, version 1 `rotating` for 24 h; on 401 with v2 during the window, fall back to v1 and alert. KMS key: automatic rotation (yearly by default); old key material still decrypts old rows.

**Revocation:** disconnect → call the PMS revoke endpoint where one exists, delete ciphertext and data key (crypto-shred), set the account to `revoked` so workers stop.

**Detection:** alert on 401 spikes per account and on unusual `Decrypt` volume in CloudTrail.

## Deep dives

**1. The leak (the twist).** Order: (1) Ask the customer to revoke the key in the PMS and issue a new one (we can't revoke it for them); store the new key as a new version. (2) Remove the plaintext: CloudWatch Logs can't delete single events, so delete the affected log stream, or the group if needed, and check export/subscription targets (S3, a log vendor) and delete there too. (3) Check who could read that log group (IAM, CloudTrail `GetLogEvents`/`FilterLogEvents`) and ask the PMS for API access logs for that key. (4) Notify the customer per contract. (5) Prevent: the `Secret` wrapper, logger redaction, a CloudWatch Logs data protection policy that masks key patterns, and a CI test that fails if a credential is serialized. What limited damage: one key per account (blast radius = one customer), encryption context, and narrow decrypt permissions.

**2. Envelope encryption vs a key in an environment variable.** Chosen: KMS-managed keys; the master key never leaves KMS, use is logged and permissioned per role. Rejected: `pgcrypto` or app-level AES with a key in an env var; a DB dump plus one leaked env var exposes all 6,000 accounts.

**3. Refresh-token race.** Two workers refresh, one rotated token invalidates the other, and the account looks disconnected. Chosen: single flight under a row lock.

## Traps

- Plaintext credentials in a `jsonb` config column.
- Calling KMS `Decrypt` on every API request; cost, latency and request quotas.
- Giving the web/API service decrypt permission "for convenience".
- Logging whole request objects including `Authorization` headers.
- Treating revocation as deleting our row; the token is still valid at the PMS.

## Say it (60–90 s)

I store credentials in Postgres with envelope encryption. For each credential, KMS generates a data key, I encrypt with AES-GCM locally, and store the ciphertext with the encrypted data key. The encryption context includes the account and partner id, so a ciphertext can't be decrypted for another account, and CloudTrail shows every decrypt by account. Only the integration worker role can decrypt; the web app can only encrypt new credentials. Workers cache plaintext in memory for a few minutes, inside a wrapper type that redacts itself in logs. OAuth refresh is single flight under a row lock, because rotating refresh tokens break with concurrent refreshes. Rotation keeps two versions valid for a day. Revocation calls the PMS revoke endpoint where possible and deletes our ciphertext. For the log leak: get the customer to revoke and replace the key, delete the log stream and any exported copies, check who read the logs and what the key was used for, notify the customer, and add redaction and a masking policy. The damage stays at one customer because each account has its own credential.

## Follow-ups

**Q:** Why not HashiCorp Vault?
**A:** Valid, especially for dynamic secrets or multi-cloud, but it's another stateful system to run. KMS plus Postgres covers this at 6,000 accounts.

**Q:** KMS is unavailable for 10 minutes.
**A:** Cached plaintext keeps active accounts working for a few minutes; new decrypts fail and those jobs retry with backoff. KMS is regional; multi-region keys if DR needs a second region.

**Q:** A customer asks who accessed their credentials.
**A:** CloudTrail `Decrypt` events filtered by encryption context `account_id`, with the role and time of each.

</details>

## Theory in the notes

- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [07-observability-reliability/02-logs-metrics-traces.md](../../07-observability-reliability/02-logs-metrics-traces.md)
