---
id: access-token-session
title: Access tokens and sessions
kind: concept
status: draft
defined_by: S01
---
# Access tokens and sessions
## Definition
An access token is a short-lived credential, signed by S01, that proves who a caller is. A session pairs it with a rotating refresh token. S01 issues both and publishes the public keys that let any service verify them. The guarantee: the caller's identity comes from the verified token alone. Access tokens last 300 s, refresh tokens 30 days and sessions 90 days. Browsers never hold a token.

## Rules
- **access-token-session.C-01** The system MUST derive the principal from the token alone, and MUST NOT trust identity headers such as `X-User-Id`.
- **access-token-session.C-02** Only `Authorization: Bearer` and the `__Host-access` cookie MUST carry credentials.
- **access-token-session.C-03** The system MUST reject tokens with `alg: none`, a forged algorithm, an unknown `kid`, a bad `typ`, or a time outside the 5 s tolerance, with one identical `401 invalid_token` body.
- **access-token-session.C-04** An access token MUST expire after 300 s; a sensitive route MUST reject the token of a revoked session at once, and an ordinary route MUST accept it until `exp`.
- **access-token-session.C-05** A refresh MUST return a new token for the same session and spend the old one; a spent token MUST revoke the session, and exactly one of two simultaneous exchanges MUST succeed.
- **access-token-session.C-06** A refresh token MUST expire 30 days after issue, and a session MUST end 90 days after creation.
- **access-token-session.C-07** Unknown, expired, revoked and deleted-user refresh failures MUST give the same `401 invalid_refresh_token`; a value above 256 characters MUST give `400`.
- **access-token-session.C-08** Browsers MUST NOT hold a token; the BFF MUST keep tokens server-side behind an HttpOnly session cookie, and responses that carry credentials MUST send `Cache-Control: no-store`.

## How the capabilities use it
- {{cap:S01}} defines it: issues access and refresh tokens, rotates refresh tokens, publishes the JWKS keys, and offers session revocation to other domains.
- {{cap:S02}} relies on S01 to issue the sessions after TOTP and Google sign-in.
- {{cap:S48}} keeps the tokens server-side behind an HttpOnly cookie, so browsers never hold one.
- {{cap:W01}} holds the signed-in state in an opaque HttpOnly session cookie and a readable CSRF cookie, never a token.

## Known gaps
- S10, S33 and S51 list this concept, but no line in the facts links it. Their use is not stated.
- A role change takes effect only at the next refresh (S01 AS-28). This is not yet a rule on this page.
- The S02 facts say only that S01 issues its sessions. They do not say how the MFA challenge turns into a session.

## Used by
<!-- used-by:start -->
- {{cap:S01}} Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
- {{cap:S02}} TOTP MFA with recovery codes, Google OIDC login (PKCE), account linking
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S33}} Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
- {{cap:S48}} BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling
- {{cap:S51}} Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out
- {{cap:W01}} Sign up, log in, forgot password, MFA step-up, session cookie via BFF, CSRF, logout, account state in the navbar
<!-- used-by:end -->
