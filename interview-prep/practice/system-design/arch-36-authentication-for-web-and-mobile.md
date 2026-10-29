# arch-36. Authentication for web and mobile

*Security · Medium*

## The question

"Our investing app has a web app and iOS/Android apps, all against one API. Users hold portfolios, and they can change the bank account that withdrawals go to. Design authentication: sessions or JWTs, how tokens are refreshed and revoked, where MFA fits, and how enterprise SSO would plug in later."

**Then:** "Support gets a call: a user's phone was stolen an hour ago. How do you kill all their sessions right now, including the mobile app?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Build or buy the identity provider (Cognito, Auth0, Keycloak)? → assume: the design holds either way; I'll describe the mechanics as if we run it, on Postgres + Redis.
- Are the web app and API on the same site? → assume: `app.example.com` and `api.example.com`, same registrable domain, so first-party cookies work.
- MFA policy? → assume: required for everyone at enrolment; step-up for risky actions (new device, changing the withdrawal account, large withdrawals).
- Session length? → assume: web idle timeout 15 min, absolute 12 h; mobile stays signed in ~30-90 days behind biometric unlock.
- SSO? → assume: later, for employer stock-plan customers, via OIDC or SAML per organization.
- Regulatory rules for strong authentication? → assume: they depend on country and product (e.g. PSD2 SCA in the EU for payment accounts); our policy below is the bar unless legal says otherwise.

## Design

**Web: server-side sessions.** Login → random 256-bit session ID in a cookie `__Host-sid; HttpOnly; Secure; SameSite=Lax; Path=/`. The session lives in Postgres (source of truth, "your devices" page, audit) with a Redis copy for the per-request lookup (~1 ms). State-changing requests also need a CSRF token or a custom header, because SameSite alone has gaps (sibling subdomains are same-site).

**Mobile: access token + rotating refresh token.**
- Access token: JWT, 10 minutes, signed ES256 with a `kid`, claims `sub`, `sid`, `amr`, `exp`. Services verify it locally via JWKS.
- Refresh token: opaque random value, stored **hashed** server-side, kept on the device in Keychain or Android Keystore-backed storage.
- Every refresh returns a new refresh token and marks the old one used. A used token presented again → revoke the whole session (reuse detection, as in the OAuth 2.0 Security BCP, RFC 9700).
```sql
sessions(id uuid PRIMARY KEY, user_id uuid, kind text,       -- web | mobile
         device_name text, created_at, last_seen_at, mfa_verified_at, revoked_at)
refresh_tokens(token_hash bytea PRIMARY KEY, session_id uuid, issued_at,
               used_at timestamptz, replaced_by bytea, expires_at)
```

**MFA and step-up.** Passkeys (WebAuthn) or TOTP (RFC 6238); SMS OTP only as a fallback because of SIM swap (NIST SP 800-63B treats SMS as a restricted authenticator). Changing the withdrawal bank account requires a fresh second factor (`mfa_verified_at` within 5 minutes), sends an alert to the old email and phone, and holds withdrawals to the new account for a set period, because account takeover aims exactly at this endpoint.

**Passwords.** argon2id, login rate limits per account and per IP, breached-password check at signup.

**SSO later.** Per-organization OIDC/SAML config; SSO users get the same session model after login. The IdP does authentication; our sessions and revocation stay ours.

**Revocation.** Set `sessions.revoked_at`, delete refresh tokens, add `sid` to a Redis revoked set with TTL = access-token lifetime. Money-moving endpoints check that set on every call; reads accept up to 10 minutes of staleness.

## Deep dives

**1. Web: sessions vs JWT.** Chosen: opaque server-side sessions. Revocation is instant, the cookie is small, and JavaScript can't read it. The cost is one lookup per request, ~1 ms in Redis. Rejected: a JWT in `localStorage`. Any XSS can read and exfiltrate it, and it can't be revoked before it expires.

**2. Refresh rotation and the concurrency race.** The app resumes, three requests get 401, and all three refresh with the same token. The first rotates it; the other two look like reuse and kill the session, so users get logged out at random. Fixes: the client does single-flight refresh (one refresh in progress, others wait on it), and the server allows a short grace window (~10-30 s) in which the just-replaced token returns the same new pair. Identity vendors expose this as a setting under different names. Rejected: long-lived refresh tokens without rotation, which stay valid for months once stolen. Later option: sender-constrained tokens with DPoP (RFC 9449), more client work.

**3. Revoking stateless tokens.** A JWT stays valid until `exp`. Options: keep access tokens short (10 min) and accept that window for reads; check a revoked-`sid` set for writes and money movement. Rejected: 1-hour access tokens (an hour of attacker access after revoke), and a DB check on every request (then a session cookie would have been simpler).

## Traps

- A JWT in `localStorage` for the web app: XSS reads it.
- "JWTs are stateless, so we don't need revocation": the stolen-phone case needs it within minutes.
- Refresh rotation without reuse detection, or without a grace window: the first leaves stolen tokens usable, the second logs out real users.
- SMS as the only second factor on an account that can move money.
- No step-up on changing the withdrawal bank account: the most valuable target for account takeover.
- Not pinning the JWT algorithm on verify (`alg: none` or HS/RS confusion).

## Say it (60–90 s)

For the web app I'd use server-side sessions: a random session ID in an HttpOnly, Secure, SameSite cookie, with the session in Postgres and cached in Redis. Revocation is instant and JavaScript can't steal the cookie. For mobile I'd use a ten-minute JWT access token plus a refresh token that rotates on every use. The refresh token is stored hashed on our side and in the Keychain or Keystore on the device. If an already-used refresh token comes back, someone copied it, so I revoke the whole session. Rotation has one practical problem: parallel requests refresh at the same time and look like reuse, so the client refreshes single-flight and the server allows a short grace window. MFA is passkeys or TOTP, with SMS only as a fallback because of SIM swapping. Changing the withdrawal bank account needs a fresh second factor, alerts the old email and phone, and holds withdrawals to the new account for a while. SSO later just replaces the login step. For the stolen phone: I mark all of that user's sessions revoked, delete their refresh tokens and put the session IDs in a Redis revoked set. The app can't refresh any more, money-moving endpoints reject at once, and remaining access tokens expire within ten minutes.

## Follow-ups

**Q:** Then: the stolen phone. Anything beyond killing sessions?
**A:** If the phone held a passkey or TOTP seed, support removes that factor and the user re-enrols on a trusted device after identity verification. Withdrawals and bank-account changes are frozen until then. We also review the account's activity log since the theft time.

**Q:** How do you rotate the JWT signing key?
**A:** Publish the new public key in JWKS first, start signing with the new `kid`, keep the old public key until every token it signed has expired (10 minutes plus margin), then remove it.

**Q:** If Redis is down, does everyone get logged out?
**A:** No. Session lookups fall back to Postgres (slower, still correct). Redis is a cache and a revocation fast path; Postgres is the record.

</details>

## Theory in the notes

- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [05-security/01-web-security-xss-csrf-csp.md](../../05-security/01-web-security-xss-csrf-csp.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
