# Contract: events of S03

Written with `OutboxService.append` inside the transaction that changes the state; a rejected operation appends nothing (AS-78). Defined with `defineEvent` in `tenancy/domain/events.ts`, aggregate `tenancy`, topic `tenancy.events`, key `shopId`; envelope `eventId, type, version, occurredAt, aggregateId (= shopId)`; payloads hold identifiers only. `shopVersion` is the entity version for read-model version guards (IX.8).

## Produced

| Type | v | Payload | Written when |
|---|---|---|---|
| `tenancy.shop_created` | 1 | `{shopId, ownerId, name, slug, plan, region, shopVersion}` | create, legacy provisioning, sandbox provisioning (`ownerId` null for sandbox: payload allows null) |
| `tenancy.shop_updated` | 1 | `{shopId, name, slug, shopVersion}` | name patch |
| `tenancy.shop_status_changed` | 1 | `{shopId, from, to, reason?, shopVersion}` | any status transition |
| `tenancy.shop_verification_changed` | 1 | `{shopId, verificationStatus, payoutsEnabled, shopVersion}` | verification machine moved |
| `tenancy.shop_plan_changed` | 1 | `{shopId, plan, shopVersion}` | plan applied |
| `tenancy.member_added` | 1 | `{shopId, userId, role, source}` | create (owner), accept, SSO provisioning, legacy provisioning |
| `tenancy.member_role_changed` | 1 | `{shopId, userId, from, to}` | role change that differs |
| `tenancy.member_removed` | 1 | `{shopId, userId, role, reason: 'removed'\|'left'\|'shop_deleted'}` | removal, self-leave, purge |
| `tenancy.invite_created` | 1 | `{shopId, inviteId, role}` | invite created or re-created |
| `tenancy.shop_cell_moved` | 1 | `{shopId, fromCell, toCell, region, version}` | directory move |
| `tenancy.shop_offboarding_started` | 1 | `{shopId, purgeAt}` | start (not on repeat) |
| `tenancy.shop_offboarding_cancelled` | 1 | `{shopId}` | cancel |
| `tenancy.shop_deleted` | 1 | `{shopId}` | purge |
| `tenancy.invite_requested` (single-consumer message, S28) | 1 | `{inviteId, shopId, shopName, email, role, token, expiresAt, invitedBy}` | invite created or resent; the only event with a secret; never logged, not published to the fan-out topic |

## Consumed

| Consumer (inbox / guard) | Topic | Type | Effect |
|---|---|---|---|
| `tenancy-sso-provisioning` (`inbox`) | `identity.events` | `identity.federated_identity_linked` v1 `{userId, provider, …}` | provider `shop:<uuid>` of an `ACTIVE` shop with SSO enabled and a free seat → membership `source:'sso'`, `defaultRole`; otherwise ignored/denied (counters) |
| `tenancy-verification` (`inbox`) | `shop.events` (S04) | `shop.onboarding_submitted`, `shop.verified`, `shop.rejected` v1 `{shopId}` | verification machine; unknown or `DELETED` shop ignored |
| `tenancy-plan` (`versionGuard`) | `billing.events` (S17) | `billing.subscription_plan_changed` v1 `{shopId, plan, version}` | `planVersion < version` only |

Payloads are validated with zod before acting; an invalid payload is a `PermanentError` (dead letter, no side effect); unknown types are skipped. Topic names for S04 and S17 are provisional (their specs do not exist); the consumer reads them from configuration constants beside the event definitions.
