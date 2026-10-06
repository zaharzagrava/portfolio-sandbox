# Authentication, Authorization, Service-to-Service Security, Secrets

Sessions vs tokens, OAuth/OIDC, password storage, authorization models (RBAC, ABAC, ReBAC), record-level security, service-to-service authentication, and secrets.

---

## 1. Sessions vs tokens

| | Server sessions (opaque ID in cookie) | Stateless JWT access tokens |
|---|---|---|
| Revocation | instant (delete session) | hard: valid until `exp` unless you add a denylist |
| Scaling | needs shared store (Redis) | no lookup per request |
| Size | small cookie | larger, sent every request |
| Data freshness | server reads current roles | roles frozen in token until refresh |
| Best for | first-party web apps | service-to-service, distributed APIs, third-party clients |

A **pragmatic hybrid** is common: short-lived JWT access tokens (5–15 min) plus long-lived **refresh tokens** stored server-side (revocable).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AuthSessionService`](../../packages/backend/libs/domains/identity/application/auth-session.service.ts#L34): AuthSessionService issues access tokens plus rotating refresh tokens and revokes sessions. _(auth-session.service.ts)_
> - [`SessionStore`](../../packages/backend/libs/domains/identity/infra/sessions/session-store.service.ts#L35): SessionStore creates, rotates and revokes server-side sessions and checks revocation, so stateless JWTs can still be revoked. _(session-store.service.ts)_
> - [`refreshSession`](../../packages/web/lib/api/client.ts#L70): The web client's refreshSession rotates the refresh cookie and stores a new access token. _(client.ts)_
<!-- theory-links:end -->

---

## 2. JWT pitfalls (a favorite senior question)

- **Validate everything**: signature, `alg` (pin the expected algorithm and never trust the header's), `exp`/`nbf` (with small clock skew), `iss`, `aud` (otherwise a token for service A works at service B), and `typ` if you use several token types.
- **`alg: none`** and **algorithm confusion**: with RS256, an attacker signs an HS256 token using your **public key** as the HMAC secret. Libraries that pick the algorithm from the header are vulnerable. Use `jose` and pass the algorithm list explicitly.
- `kid` header injection (path traversal or SQL injection in key lookup). Fetch keys from a **JWKS** with caching and an allowlist.
- JWTs are **signed, not encrypted**: anyone can base64-decode the payload, so no PII or secrets in it.
- **Don't put permissions that change often** into long-lived tokens.
- Refresh token **rotation with reuse detection**: each refresh returns a new refresh token and invalidates the old one. If an old one gets reused, assume theft and revoke the whole token family.

```ts
import { jwtVerify, createRemoteJWKSet } from 'jose';
const JWKS = createRemoteJWKSet(new URL('https://auth.example.com/.well-known/jwks.json'));
const { payload } = await jwtVerify(token, JWKS, {
  issuer: 'https://auth.example.com/', audience: 'billing-api', algorithms: ['RS256'], clockTolerance: 5,
});
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`KeyStore`](../../packages/backend/libs/domains/identity/infra/keys/key-store.service.ts#L28): KeyStore manages ES256 signing key rotation and verifies tokens by kid. _(key-store.service.ts)_
> - [`WellKnownController`](../../packages/backend/libs/domains/identity/api/well-known.controller.ts#L12): WellKnownController publishes the JWKS public keys at /.well-known/jwks.json. _(well-known.controller.ts)_
> - [`AuthService`](../../packages/backend/libs/domains/identity/application/auth.service.ts#L34): AuthService issues and verifies RS256 JWTs. _(auth.service.ts)_
<!-- theory-links:end -->

---

## 3. Where to store tokens in the browser

| Storage | XSS | CSRF | Notes |
|---|---|---|---|
| `localStorage` | ❌ readable by any injected script | ✅ immune | simple but XSS = account takeover |
| JS memory | ❌ still accessible during XSS, lost on reload | ✅ | refresh via HttpOnly cookie |
| **HttpOnly Secure SameSite cookie** | ✅ not readable (XSS can still *use* the session while the page is open) | needs CSRF defense | recommended |
| **BFF pattern** | ✅ tokens never reach browser; BFF holds them server-side; browser has session cookie | CSRF defense on BFF | current best practice for SPAs (OAuth for Browser-Based Apps BCP) |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`setAccessToken`](../../packages/web/lib/api/client.ts#L20): The web client keeps the access token in memory via setAccessToken and sends it as a bearer header. _(client.ts)_
> - [`csrfHeaders`](../../packages/web/lib/api/client.ts#L30): csrfHeaders reads the __Host-csrf cookie and sends it as x-csrf-token for cookie-protected endpoints. _(client.ts)_
> - [`AuthController`](../../packages/backend/libs/domains/identity/api/auth.controller.ts#L26): AuthController sets the refresh token in secure cookies. _(auth.controller.ts)_
<!-- theory-links:end -->

---

## 4. OAuth 2.0 / OIDC essentials

- **OAuth 2.0** = delegated **authorization** (access tokens for APIs). **OIDC** = an **authentication** layer on top (the ID token tells the client *who* the user is).
- ID token: for the **client**, never send it to APIs as an access token. Access token: for the **resource server**, validated against `aud`.
- Flows:
  - **Authorization Code + PKCE**: for every user-facing client (SPA, mobile, server). PKCE stops authorization code interception.
  - **Client Credentials**: machine-to-machine (service to service).
  - **Device Code**: TVs and CLIs.
  - Implicit flow and Resource Owner Password: **deprecated** (removed in OAuth 2.1).
- Use `state` (CSRF for the redirect) and `nonce` (ID token replay), and **exact redirect URI matching**.
- Scopes describe *what the client may do on the user's behalf*. They are not a full permission system.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OidcService`](../../packages/backend/libs/domains/identity/infra/oidc/oidc.service.ts#L30): OidcService runs the OIDC flow, registers providers and validates ID tokens. _(oidc.service.ts)_
> - [`ShopSsoService`](../../packages/backend/libs/domains/tenancy/application/shop-sso.service.ts#L13): ShopSsoService resolves per-shop OIDC providers and stores their encrypted credentials. _(shop-sso.service.ts)_
> - [`OidcProviderConfig`](../../packages/backend/libs/domains/identity/infra/oidc/oidc.service.ts#L6): OidcProviderConfig defines issuer, clientId, clientSecret and scope for each provider. _(oidc.service.ts)_
<!-- theory-links:end -->

---

## 5. Password storage and authentication hardening

- Hash with **Argon2id** (memory-hard; for example m=19 MiB, t=2, p=1 per OWASP), or bcrypt (cost ≥ 12, inputs truncated at 72 bytes), or scrypt. **Never** SHA-256 alone.
- Brute force: rate limit per account **and** per IP, progressive delays, CAPTCHA after failures, breached-password checks (HIBP k-anonymity API).
- MFA: TOTP, WebAuthn/**passkeys** (phishing-resistant). SMS is weak (SIM swap).
- Session fixation: **regenerate the session ID on login** and on privilege change.
- Re-authenticate for sensitive actions (changing email or password, payouts).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PasswordHasher`](../../packages/backend/libs/domains/identity/infra/crypto/password-hasher.ts#L13): PasswordHasher hashes and verifies passwords and migrates the algorithm on verify. _(password-hasher.ts)_
> - [`RATE_LIMIT_POLICIES`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.types.ts#L37): RATE_LIMIT_POLICIES includes an auth.login policy for brute-force protection. _(rate-limit.types.ts)_
> - [`PasswordLoginDto`](../../packages/backend/libs/domains/identity/api/auth.dto.ts#L35): PasswordLoginDto caps the password at 72 chars, matching the bcrypt input limit. _(auth.dto.ts)_
<!-- theory-links:end -->

---

## 6. Authorization models

| Model | Idea | Example | When |
|---|---|---|---|
| **RBAC** | permissions via roles | `finance_manager` can `invoice:approve` | most business apps; simple, auditable |
| **ABAC** | rules over attributes of user, resource, environment | "approve if amount < user.limit AND resource.department == user.department AND business hours" | fine-grained, contextual |
| **ReBAC** | permissions from relationships graph | Google Zanzibar: "user is editor of folder that contains doc" | collaborative apps (docs, orgs, teams) — OpenFGA, SpiceDB |
| ACL | per-resource list of principals | file sharing | small scale |

Real systems combine them: **RBAC for coarse capabilities + record-level rules (ABAC/ReBAC) for data scope.**

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ROLE_PERMISSIONS`](../../packages/backend/libs/domains/tenancy/domain/permissions.ts#L29): ROLE_PERMISSIONS maps each shop role to its permissions, which is the RBAC matrix. _(permissions.ts)_
> - [`can`](../../packages/backend/libs/domains/tenancy/domain/permissions.ts#L36): can() checks whether a role holds a given permission. _(permissions.ts)_
> - [`SHOP_PERMISSIONS`](../../packages/backend/libs/domains/tenancy/domain/permissions.ts#L8): SHOP_PERMISSIONS lists every permission string. _(permissions.ts)_
<!-- theory-links:end -->

### Policy engines
- OPA (Rego), **Cedar** (AWS Verified Permissions), Casbin, CASL (popular in Nest/JS for the frontend and backend).
- Benefit: policies are centralized, testable, and auditable, separate from business code.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopicPolicy`](../../packages/backend/libs/infrastructure/realtime/topic-registry.ts#L9): TopicPolicy is a per-topic access-check function in the realtime registry, a small in-code policy layer. _(topic-registry.ts)_
<!-- theory-links:end -->

---

## 7. Record-level security (query scoping)

The hard part isn't checking "can the user approve invoices". It's "**which rows** can this user see", applied to **every query**, including lists, joins, aggregates, and exports.

### Option A: Application-level query scoping
```ts
// Central policy → Sequelize where-clause generator
function invoiceScope(user: AuthUser): WhereOptions<Invoice> {
  if (user.roles.includes('admin')) return {};
  const ors: WhereOptions<Invoice>[] = [];
  if (user.roles.includes('finance')) ors.push({ departmentId: { [Op.in]: user.departmentIds } });
  if (user.roles.includes('project_manager')) ors.push({ projectId: { [Op.in]: user.managedProjectIds } });
  if (ors.length === 0) return { id: null }; // deny-by-default: matches nothing
  return { [Op.or]: ors };
}
await Invoice.findAll({ where: { [Op.and]: [invoiceScope(user), filters] } });
```
Key points to make:
- **Deny by default.** An unknown role returns nothing.
- Centralized and composable: apply it through repository methods, Sequelize **scopes**, or hooks (`beforeFind`), so developers can't forget it.
- Apply to **associations** too (an `include` of related records must respect the related model's scope).
- **Performance**: the generated predicates must be index-friendly (`department_id = ANY($1)` with an index); avoid huge `IN` lists by joining against membership tables; check plans for all role combinations.
- **Testing**: matrix tests (role × resource × action), plus "list endpoints never return out-of-scope rows" property tests.
- Weakness: a raw query or new code path that bypasses the repository leaks data, which is the motivation for RLS.

### Option B: Postgres Row-Level Security (RLS)
```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;   -- apply to table owner too
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = current_setting('app.tenant_id')::bigint);
```
```ts
await db.transaction(async (tx) => {
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(user.tenantId)]); // true = tx-local (SET LOCAL)
  return tx.query('SELECT * FROM invoices');   // automatically filtered
});
```
- ✅ The DB enforces it, so new code paths can't forget it.
- ⚠️ Use **transaction-local** settings (`SET LOCAL` / `set_config(..., true)`). Session-level `SET` leaks across pooled connections, which is a **cross-tenant data leak** with PgBouncer.
- ⚠️ Superusers and roles with `BYPASSRLS` skip policies. The app role must not have them. Without `FORCE`, the table owner bypasses RLS.
- ⚠️ Policy predicates run on every row, so index the columns they use and keep the functions `STABLE`/leakproof.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShopTransactionRunner`](../../packages/backend/libs/domains/tenancy/infra/shop-transaction.ts#L14): ShopTransactionRunner sets the tenant for Postgres RLS inside the transaction, or does an audited cross-tenant bypass. _(shop-transaction.ts)_
> - [`ShopSsoConfig`](../../packages/backend/libs/domains/tenancy/infra/models/shop-sso-config.model.ts#L5): ShopSsoConfig is a Sequelize model protected by RLS. _(shop-sso-config.model.ts)_
<!-- theory-links:end -->

### IDOR / BOLA (OWASP API Security #1)
`GET /invoices/123` where 123 belongs to another tenant. **Always scope lookups by the principal**: `WHERE id = $1 AND tenant_id = $2`, never `findByPk(id)` followed by an ownership check in some later code path. Unguessable IDs (UUIDs) are *not* authorization.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ApiKeyGuard`](../../packages/backend/libs/domains/developer-platform/api/api-key.guard.ts#L17): ApiKeyGuard validates the bearer key and scopes, then sets the tenant context so lookups are scoped to the shop. _(api-key.guard.ts)_
> - [`ShopService`](../../packages/backend/libs/domains/tenancy/application/shop.service.ts#L21): ShopService enforces multi-tenant access boundaries. _(shop.service.ts)_
<!-- theory-links:end -->

---

## 8. Service-to-service authentication (who is really calling?)

Threat: inside the network, a compromised or misconfigured service calls another service pretending to be someone else, or **replays a user's token** to a service it was never meant for.

Approaches:
1. **mTLS** (often through a service mesh: Istio or Linkerd): each workload has a certificate identity (SPIFFE ID `spiffe://cluster/ns/billing/sa/invoice-svc`). Authorization policies say "only `invoice-svc` may call `ledger-svc` POST /entries". Identity lives at the transport layer and is rotated automatically.
2. **OAuth2 client credentials**: each service gets its own client ID and secret (or better, workload identity), gets a JWT from the IdP with `aud=ledger-svc`, and the receiver validates `iss`, `aud`, `azp/client_id`.
3. **Signed service tokens**: each service signs short-lived JWTs with its own private key. The receiver keeps an allowlist of issuers and public keys. This is where "validating the token's origin" comes in: check that the `iss`/`sub` is an allowed caller **for this endpoint**, not just that the signature is valid.
4. **Cloud IAM**: AWS SigV4 with IAM roles (API Gateway IAM auth, Lambda invoke permissions), and EKS **IRSA / Pod Identity** to give pods IAM roles without static keys.

User context propagation:
- **Token exchange** (RFC 8693): service A trades the user's token for one scoped to service B, with an `act` (actor) claim, so B knows both "user X" and "via service A".
- Never forward the user's token blindly to every service, because its audience should be specific.

Defenses against **spoofing**:
- Don't trust headers like `X-User-Id` from the network. Only trust them when they're set by a gateway that **strips client-supplied versions** and the service only accepts traffic from that gateway (mTLS or a network policy).
- **K8s NetworkPolicies** for default-deny, allowing only expected caller-to-callee paths.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`UserAuthGuard`](../../packages/backend/libs/domains/identity/api/guards/user-auth.guard.ts#L11): UserAuthGuard verifies the auth token and attaches the user to the request. _(user-auth.guard.ts)_
> - [`signCollabTicket`](../../packages/backend/libs/domains/catalog/infra/collab-ticket.ts#L17): signCollabTicket signs a short-lived 60-second JWT for the collaboration service. _(collab-ticket.ts)_
> - [`verify_ticket`](../../packages/hft-platform/src/auth.rs#L29): verify_ticket in the HFT platform checks the ticket JWT and token type before accepting it. _(auth.rs)_
<!-- theory-links:end -->

---

## 9. Secrets management

- Never in the repo, the Docker image, or plain ConfigMaps. Use **AWS Secrets Manager / SSM Parameter Store**, HashiCorp Vault, and in K8s the **External Secrets Operator** (syncs into K8s Secrets) or CSI secrets store.
- K8s Secrets are only **base64-encoded**. Enable **encryption at rest** (KMS provider) and RBAC on secrets.
- **Rotation**: design for two valid credentials during rotation (dual secrets for webhooks and DB users).
- CI/CD: **OIDC federation** (GitHub Actions or GitLab to AWS IAM role) instead of long-lived access keys.
- **Envelope encryption** for sensitive fields (KMS data keys): encrypt PII or bank account numbers at field level, so DB dumps or replicas don't expose them. Use blind indexes (an HMAC of the value) when you need equality search.
- Audit logs: who accessed which financial records and when, in append-only storage.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SecretBox`](../../packages/backend/libs/domains/identity/infra/crypto/secret-box.ts#L14): SecretBox seals and opens encrypted field values. _(secret-box.ts)_
> - [`SecretsManagerConfig`](../../packages/backend/libs/common/config/types.ts#L17): SecretsManagerConfig holds configuration fetched from AWS Secrets Manager. _(types.ts)_
> - [`ConfigUtilsService`](../../packages/backend/libs/common/config/config-utils/config-utils.service.ts#L10): ConfigUtilsService validates configuration with Joi schemas. _(config-utils.service.ts)_
<!-- theory-links:end -->

---

## 10. OWASP API Security Top 10 (2023): map each item to a defense

1. **BOLA**: scope every lookup by the principal; RLS.
2. **Broken Authentication**: standard libraries, token validation, rate-limited login.
3. **Broken Object Property Level Authorization**: DTO whitelists on input (mass assignment) and output serialization (don't return `passwordHash`).
4. **Unrestricted Resource Consumption**: rate limits, pagination caps, payload size limits, timeouts, GraphQL cost limits.
5. **Broken Function Level Authorization**: guards on every route; deny by default; admin routes separated.
6. **Unrestricted Access to Sensitive Business Flows**: anti-automation on signup and checkout (bots, scalping).
7. **SSRF**: see the web security doc.
8. **Security Misconfiguration**: headers, CORS, verbose errors, default credentials.
9. **Improper Inventory Management**: old API versions still running unpatched (the deprecation process!).
10. **Unsafe Consumption of APIs**: validate third-party responses and set timeouts. Don't trust partner data.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RATE_LIMIT_POLICIES`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.types.ts#L37): RATE_LIMIT_POLICIES covers the unrestricted resource consumption item. _(rate-limit.types.ts)_
> - [`BulkStockBody`](../../packages/backend/libs/domains/developer-platform/api/v1.controller.ts#L34): BulkStockBody limits input to 1 to 10,000 items, a payload-size cap. _(v1.controller.ts)_
> - [net](../../docs/humans/concepts/platform-net/net.md): The net module gives SSRF-protected fetching of untrusted URLs.
<!-- theory-links:end -->

---

## Interview Q&A

**Q: How do you implement record-level access control, and keep it from being bypassed?**
A central policy module turns the user's roles and attributes into composable Sequelize where-clauses. It's deny-by-default and applied in the repository layer and through scopes and hooks, so every `find`, including includes and aggregates, gets it. It's index-friendly so performance holds, and a role × resource test matrix covers it. To protect against bypass, I'd add Postgres RLS as a second layer with transaction-local settings, and code review rules against raw queries.

**Q: How do services authenticate to each other?**
Workload identity: mTLS through a mesh, or short-lived client-credential JWTs with a specific `aud`. The receiver validates issuer, audience, and an allowlist of callers per endpoint. Combine with network policies for default-deny. User context goes through token exchange, never through trusted plain headers.

**Q: JWT or sessions for a web app?**
For a first-party web app: server sessions in an HttpOnly, Secure, SameSite cookie, through a BFF if it's an SPA, because they're easy to revoke. JWTs for service-to-service and third-party API access, short-lived, with refresh rotation.
