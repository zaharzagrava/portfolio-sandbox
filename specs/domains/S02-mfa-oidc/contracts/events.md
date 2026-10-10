# Contract: events emitted by S02

Written through `OutboxService.append` inside the transaction that changes the state (FR-090); a rejected operation appends nothing. Defined with `defineEvent` in `identity/domain/events.ts`, aggregate `identity`, topic key `userId`, envelope `eventId, type, version, occurredAt, aggregateId (= userId), payload` (FR-092, S01 FR-094). Identifiers and flags only: no e-mail, secret, code or digest. Identity consumes no events.

| Type | v | Payload | Written when |
|---|---|---|---|
| `identity.mfa_enabled` | 1 | `{userId}` | confirm succeeds |
| `identity.mfa_disabled` | 1 | `{userId, reason: 'user' \| 'account_linking'}` | disable by the user; linking wipe of an enabled factor |
| `identity.mfa_recovery_code_used` | 1 | `{userId, remaining}` | a recovery code spent at login or at disable |
| `identity.mfa_recovery_codes_regenerated` | 1 | `{userId}` | regenerate succeeds |
| `identity.federated_identity_linked` | 1 | `{userId, provider, linkMethod: 'login' \| 'email_match' \| 'explicit', passwordInvalidated, mfaReset}` | link inserted (first login, e-mail match, explicit link) |
| `identity.federated_identity_unlinked` | 1 | `{userId, provider}` | unlink deletes a row |
| `identity.user_registered` (S01) | 1 | `{userId, role}` | Google-created account |

Consumers: **S28** (security mails; resolves addresses with `UserDirectoryService`), **S03** (may subscribe to `identity.user_registered` / `identity.federated_identity_linked` for shop membership). Delivery guarantees and consumer idempotency are theirs and S53's.

Audit lines (no secrets): `auth.mfa.enrolled|confirmed|failed|verified|recovery_used|regenerated|disabled|challenge_burned`, `auth.oidc.started|callback_failed|login|linked|unlinked`. Counters: `auth_mfa_total{outcome}`, `auth_mfa_challenge_burned_total`, `auth_oidc_callback_total{outcome}`, `auth_oidc_provider_timeout_total`, `auth_identity_linked_total{method}`.
