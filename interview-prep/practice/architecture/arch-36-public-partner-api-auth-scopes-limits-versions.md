# arch-36. Public partner API: auth, scopes, limits, versions

*API Design · Medium*

## The question

"We're opening an API to ~200 partners (PMS vendors and large property managers) so they can create payment requests, read payment status and list payouts. Some partners act for hundreds of landlords. Average load is ~50 req/s, with a few partners bursting to 500 req/s. How do you authenticate them, control what each one can touch, rate-limit, version the API, and let them test?"

**Then:** "A partner's production credential shows up in a public GitHub repo. Walk me through what happens."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Server-to-server only, or do browsers call it too? → assume: partner backends only. No public clients, no CORS.
- How does a partner get access to a landlord's data? → assume: the landlord grants it in our dashboard (a consent step), stored as a grant. The partner can't grant itself.
- Card data through this API? → assume: never. Card entry stays on PSP hosted fields, so the API stays out of PCI DSS cardholder-data scope.
- Webhooks to partners? → assume: yes, designed separately (arch-08).
- Do partners' security teams require OAuth? → assume: some do; most just want something simple.
- Sandbox? → assume: yes, separate credentials and base URL; details in arch-46.

## Design

**Authentication.** OAuth 2.0 **client credentials**: the partner posts its client credential to `POST /oauth/token` and gets a 15-minute JWT access token (`sub = client_id`, `scope`, `env`). Client authentication by `client_secret` for most partners, `private_key_jwt` or mTLS for partners who want no shared secret. The gateway verifies the JWT locally against our JWKS: no DB call per request.

**Authorization: two checks on every request.**
1. *Scope*: `payments:write`, `payments:read`, `payouts:read` from the token.
2. *Ownership*: the landlord behind the resource must have an active grant for this partner. Enforced in one repository layer that every query goes through, not in each controller.

```sql
api_clients(id, partner_id, env text,            -- live | sandbox
            scopes text[], status, created_at)
api_credentials(id, client_id, kind text,        -- secret | public_key
                secret_hash bytea, prefix text,   -- 'rpk_live_8f3a' shown in the dashboard
                last_used_at, expires_at, revoked_at)
partner_grants(partner_id, landlord_id, scopes text[], granted_by, granted_at, revoked_at,
               PRIMARY KEY (partner_id, landlord_id))
```
Secrets are 256-bit random, shown once, stored as SHA-256. Two active credentials per client allow rotation without downtime.

**Rate limits.** Token bucket per client in Redis (one Lua script = atomic check-and-decrement): e.g. 100 req/s sustained, burst 500, lower for writes. Over the limit → `429` + `Retry-After`. Remaining quota is exposed in response headers (the IETF `RateLimit` header fields are still a draft; many APIs use `X-RateLimit-*`).

**Versioning.** `/v1` in the URL for the major version. Inside it, date-based versions pinned per client on first use (`Api-Version: 2026-10-01` overrides). Adding fields needs no new version; renaming or removing does. Old versions are served by response transformers from newest to oldest. Deprecation is announced with `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers plus email.

**Support.** Every response carries `Request-Id`; a request log (client, landlord, endpoint, status, latency, no bodies) lets support answer "what did we send you" without reading PII.

## Deep dives

**1. API keys vs client credentials.** Plain API keys are simpler and work well for many payment APIs (Stripe uses them). Their cost: a long-lived secret travels on every request and ends up in partner logs and proxies. Client credentials send the secret only to the token endpoint every ~15 minutes, put scopes in a standard token, and allow `private_key_jwt`, where we hold only a public key. Chosen: client credentials, because partners act for many landlords and their security reviews ask for it. API keys remain fine for sandbox if we want the lowest friction.

**2. Ownership (BOLA).** "Broken object level authorization" is #1 in the OWASP API Security Top 10: partner B calls `GET /payments/pay_123` that belongs to partner A's landlord. Unguessable IDs are not authorization. Chosen: grant check in the data-access layer, return `404` (not `403`) so IDs can't be probed, and a test suite that tries cross-partner access on every endpoint. Rejected: putting landlord IDs inside the token; grants change and tokens live 15 minutes.

**3. Distributed rate limiting.** In-memory counters per instance give N times the limit and uneven results behind a load balancer. Redis gives one counter. If Redis is down, fall back to a local limit at a conservative fraction (fail open but bounded) rather than rejecting all traffic. Rejected as the only control: API Gateway usage plans. AWS documents their throttles and quotas as best-effort, not hard limits.

## Traps

- Storing API secrets encrypted "so we can show them again": one DB leak exposes every partner. Store a hash, show once.
- Hashing high-entropy secrets with bcrypt: ~100 ms CPU per request for no gain. bcrypt protects low-entropy passwords; a 256-bit random secret only needs SHA-256.
- Checking scope but not ownership: scopes say *what kind* of action, not *whose* data.
- Rate limiting in process memory per instance.
- Treating API Gateway usage plans as a hard limit or a security control.
- Shipping breaking changes "small enough" without a version: partners' parsers break silently in production.

## Say it (60–90 s)

Partners are backends, so I'd use OAuth client credentials. A partner exchanges its client secret, or a signed JWT if they don't want a shared secret, for a 15-minute access token with scopes. Our gateway verifies the token locally with our public keys, so there's no database hit per request. Authorization has two checks: the scope in the token, and ownership, meaning the landlord behind the resource has granted access to this partner. The ownership check lives in the data-access layer, so no endpoint can forget it, and a cross-partner request returns 404. Secrets are random, shown once and stored as a hash, and each client can have two active secrets so they rotate without downtime. Rate limiting is a token bucket per client in Redis, for example 100 per second with bursts to 500, returning 429 with Retry-After. For versioning, the URL carries the major version, and inside it each partner is pinned to a dated version on first call, so I can ship a breaking change without breaking anyone; old versions are served by response transformers. Deprecation goes out with Sunset headers and email. Partners test against a separate sandbox with separate credentials. Every response has a request ID, and we log metadata, not bodies, so support can debug without touching personal data.

## Follow-ups

**Q:** The credential leaked on GitHub. What happens?
**A:** With a distinctive prefix (`rpk_live_` plus a checksum) we can join GitHub's secret scanning partner program and get notified automatically. Revoke immediately (it can create payment requests), issue a new one, search the request log by credential ID since the leak time for unknown IPs or unusual endpoints, and tell the partner what was called.

**Q:** Why not put the landlord list in the token?
**A:** Grants change at any time and a partner can have hundreds of landlords. The token says who the client is; the grant table, cached for ~60 s and invalidated on revoke, says what it may touch.

**Q:** How does `list payouts` paginate?
**A:** Opaque cursor over `(created_at, id)`, `limit` max 100, `has_more`. No offsets: they get slow and skip or repeat rows while new payouts are inserted.

</details>

## Theory in the notes

- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [04-api-design/02-api-versioning-and-deprecation.md](../../04-api-design/02-api-versioning-and-deprecation.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
