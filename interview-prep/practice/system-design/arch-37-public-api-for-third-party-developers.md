# arch-37. Public API for third-party developers

*API Design · Medium*

## The question

"We're opening our shipping API to ~200 partners: e-commerce platforms and warehouses that create shipments, buy labels (charged to the merchant's account) and read tracking. Some partners act for hundreds of merchants. Average load is ~50 req/s, with a few partners bursting to 500 req/s. How do you authenticate them, control what each one can touch, rate-limit, version the API, and give them a sandbox?"

**Then:** "A partner's production credential shows up in a public GitHub repo. Walk me through what happens."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Server-to-server only, or browsers too? → assume: partner backends only. No public clients, no CORS.
- How does a partner get access to a merchant's account? → assume: the merchant grants it in our dashboard (a consent step), stored as a grant. A partner can't grant itself.
- What can cost money? → assume: buying a label charges the merchant's balance; voiding an unused label refunds it within a carrier-specific window.
- Webhooks to partners (tracking events)? → assume: yes, designed separately.
- Do partners' security teams require OAuth? → assume: some do; most want something simple.
- Sandbox needs? → assume: labels that never ship, tracking events on demand, and failures (address invalid, carrier down, returned to sender) without waiting days.

## Design

**Authentication.** OAuth 2.0 **client credentials**: the partner posts its credential to `POST /oauth/token` and gets a 15-minute JWT (`sub = client_id`, `scope`, `env`). Client auth by `client_secret` for most, `private_key_jwt` or mTLS for partners who want no shared secret. The gateway verifies the JWT locally against our JWKS: no DB call per request.

**Authorization: two checks on every request.**
1. *Scope*: `shipments:write`, `labels:write`, `tracking:read`.
2. *Ownership*: the merchant behind the resource has an active grant for this partner. Enforced in one repository layer every query goes through.
```sql
api_clients(id, partner_id, env text, scopes text[], status)      -- env: live | sandbox
api_credentials(id, client_id, kind text, secret_hash bytea,
                prefix text,          -- 'shp_live_8f3a', shown in the dashboard
                last_used_at, expires_at, revoked_at)
partner_grants(partner_id, merchant_id, scopes text[], granted_by, granted_at, revoked_at,
               PRIMARY KEY (partner_id, merchant_id))
```
Secrets are 256-bit random, shown once, stored as SHA-256. Two active credentials per client allow rotation without downtime.

**Rate limits.** Token bucket per client in Redis (one Lua script = atomic check-and-take): e.g. 100 req/s sustained, burst 500, lower for label purchases. Over the limit → `429` + `Retry-After`.

**Versioning.** `/v1` in the URL for the major version; inside it, date-based versions pinned per client on first call (`Api-Version: 2026-10-01` overrides). Adding fields needs no new version; renaming or removing does. Old versions are served by response transformers, newest to oldest. Deprecation via `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers plus email.

**Sandbox.** A separate deployment of the same commit in a separate AWS account, own database, base URL `sandbox.api.example.com`; `shp_test_` credentials exist only there. Carriers are replaced by a simulated carrier adapter with documented magic values (postal code `00001` → "address invalid", reference `RTS` → returned to sender after 3 simulated days). Test clocks advance time so multi-day tracking runs in seconds; `POST /v1/test_helpers/tracking_events` fires an event on demand.

## Deep dives

**1. API keys vs client credentials.** Plain API keys are simpler and many APIs use them well. Their cost: a long-lived secret travels on every request and ends up in partner logs and proxies. Client credentials send the secret only to the token endpoint every ~15 minutes, put scopes in a standard token, and allow `private_key_jwt`, where we hold only a public key. Chosen: client credentials, because partners act for many merchants and their security reviews ask for it.

**2. Ownership (BOLA).** "Broken object level authorization" is #1 in the OWASP API Security Top 10: partner B calls `GET /shipments/shp_123` that belongs to partner A's merchant. Unguessable IDs are not authorization. Chosen: the grant check in the data-access layer, `404` (not `403`) so IDs can't be probed, and a test suite that tries cross-partner access on every endpoint. Rejected: merchant IDs inside the token; grants change and tokens live 15 minutes.

**3. Sandbox fidelity.** A simulated carrier that always succeeds teaches partners nothing. The simulator implements the same carrier port and passes the same contract test suite as real carrier adapters (states, error shapes, idempotency, timing), so documented behaviour is enforced in CI. Rejected: a `livemode` flag in the production database (one missing filter leaks test data, and sandbox load tests hit production) and using internal staging (we break it mid-day by design).

## Traps

- Storing API secrets encrypted "so we can show them again": one DB leak exposes every partner. Store a hash, show once.
- Hashing high-entropy secrets with bcrypt: ~100 ms CPU per request for no gain. bcrypt protects low-entropy passwords; a 256-bit random secret only needs SHA-256.
- Checking scope but not ownership: scopes say *what kind* of action, not *whose* data.
- Rate limiting in process memory per instance: N instances = N × the limit.
- Treating API Gateway usage plans as a hard limit: AWS documents their throttles and quotas as best-effort.
- Test credentials that production accepts.

## Say it (60–90 s)

Partners are backends, so I'd use OAuth client credentials. A partner exchanges its client secret, or a signed JWT if they don't want a shared secret, for a fifteen-minute access token with scopes. Our gateway verifies the token locally with our public keys, so there's no database hit per request. Authorization has two checks: the scope in the token, and ownership, meaning the merchant behind the resource has granted access to this partner. The ownership check lives in the data-access layer, so no endpoint can forget it, and a cross-partner request returns 404. Secrets are random, shown once and stored as a hash, and each client can have two active secrets so they rotate without downtime. Rate limiting is a token bucket per client in Redis, with a lower limit for label purchases, returning 429 with Retry-After. The URL carries the major version, and inside it each partner is pinned to a dated version, so I can ship a breaking change without breaking anyone. The sandbox is a separate deployment of the same code with its own database and credentials, a simulated carrier with documented magic values, and test clocks, so a week of tracking runs in seconds.

## Follow-ups

**Q:** Then: the credential leaked on GitHub. What happens?
**A:** With a distinctive prefix (`shp_live_` plus a checksum) we can join GitHub's secret scanning partner program and get notified automatically. Revoke immediately (it can buy labels on merchants' accounts), issue a new one, search the request log by credential ID since the leak time for unknown IPs or unusual endpoints, void any labels bought by unknown callers inside the carriers' void window, and tell the partner what was called.

**Q:** Why not put the merchant list in the token?
**A:** Grants change at any time and a partner can have hundreds of merchants. The token says who the client is; the grant table, cached for ~60 s and invalidated on revoke, says what it may touch.

**Q:** How does `list shipments` paginate?
**A:** An opaque cursor over `(created_at, id)`, `limit` max 100, `has_more`. No offsets: they get slow and skip or repeat rows while new shipments are inserted.

</details>

## Theory in the notes

- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [04-api-design/02-api-versioning-and-deprecation.md](../../04-api-design/02-api-versioning-and-deprecation.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [08-devops-cloud/04-testing-strategy.md](../../08-devops-cloud/04-testing-strategy.md)
