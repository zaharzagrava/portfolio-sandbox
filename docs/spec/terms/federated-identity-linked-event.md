---
id: federated-identity-linked-event
title: identity.federated_identity_linked event
kind: term
status: draft
aliases: [identity.federated_identity_linked]
defined_for: S03-shops-rbac
rules_hash: 2dd737b558ec
---
# identity.federated_identity_linked event
## Definition
`identity.federated_identity_linked` is an event that says a user has signed in through an [external identity provider ↗](../sw-external-terms.md#identity-provider) and is now linked to it. The tenancy capability consumes it to create [shop memberships](shop-membership.md) for people who use company sign-in. When the provider belongs to a shop, this event starts member provisioning for that shop. [Events can be delivered more than once ↗](../sw-external-terms.md#at-least-once-delivery), so tenancy handles a repeated event without making a second change. A redelivered event never adds back a member who was removed.

## Example
A user signs in through the identity provider that a shop's owner set up with [`PUT /shops/:shopId/sso`](put-shops-sso.md). The identity side publishes `identity.federated_identity_linked`. Tenancy then adds the user as a member with [`source: sso`](membership-removal-source.md) and the provider's default role. This happens only if SSO is enabled, the shop is `ACTIVE` and a seat is free.

## Known gaps
- The spec does not say what the event payload contains, for example which user, provider or shop fields it carries.
- The spec does not say whether the event fires on every company sign-in or only the first time an identity is linked.
- Not confirmed in the code: which consumer class receives this event. The code facts for this behaviour point only to `SsoProvisioningService`.

## Used by
<!-- used-by:start -->
- [member-provisioning](member-provisioning.md)
- [shop-membership](shop-membership.md)
<!-- used-by:end -->
