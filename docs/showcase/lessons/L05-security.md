# L05 — Security → where it's used

| Topic (notes 05/01–02) | Implemented in | Status |
|---|---|---|
| XSS: output encoding, sanitised user HTML/markdown | SD-11, SD-05 | planned |
| CSP (strict, nonce) for rendered pages; `frame-ancestors` | SD-01 embed pages; FE phase 2 for Next.js nonce | planned |
| Security headers (helmet: HSTS, nosniff, CORP, COOP; Referrer-Policy) | F-01 | planned |
| CSRF (double-submit / SameSite, Origin check) for cookie-auth endpoints | SD-39, SD-04, SD-01 | planned |
| CORS strict allowlist (not a security boundary — documented) | F-01 | planned |
| Safe error messages | F-01 | planned |
| SSRF | SD-30, SD-35 (shared guard) | planned |
| Injection (parameterised raw SQL, CQL prepared statements) | all raw queries; review checklist | planned |
| Upload security (separate domain, nosniff, attachment, AV scan, magic bytes) | SD-10, SD-27 | planned |
| Untrusted code isolation (`vm` is not a sandbox) | SD-40 | planned |
| Sessions vs JWT, JWT pitfalls (alg pinning, kid, exp/aud/iss) | SD-39 | planned |
| Token storage in browser (BFF, HttpOnly) | SD-04, SD-39 | planned |
| OAuth 2 / OIDC + PKCE | SD-39 | planned |
| Password hashing (Argon2id), brute force, enumeration | SD-39 | planned |
| RBAC / ABAC / policy checks | SD-02 | planned |
| Record-level security, RLS, BOLA tests | SD-02, SD-07 | planned |
| Service-to-service auth | SD-39 | planned |
| Secrets management (Secrets Manager, encrypted columns) | SD-39, SD-30, SD-36, SD-44, O-03 | planned |
| OWASP API Top 10 mapping | SD-07 doc | planned |
