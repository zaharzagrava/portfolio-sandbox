---
id: member-provisioning
title: Member provisioning
kind: term
status: draft
aliases: [provisioned, provisioning]
defined_for: S03-shops-rbac
rules_hash: 07c960b96a1b
---
# Member provisioning
## Definition
Member provisioning means a shop membership is created automatically when a user signs in through the shop's own [identity provider ↗](../sw-external-terms.md#identity-provider). It is triggered by the [`identity.federated_identity_linked` event](federated-identity-linked-event.md). The new member gets [`source: sso`](membership-removal-source.md) and the provider's [default role](provider-default-role.md). Provisioning happens only once, only while SSO is enabled, only while the shop is [`ACTIVE`](shop-status.md), and only if a [seat](seat.md) is free. An existing member keeps their role. A member who was removed is not added back when the same event is delivered again.

## Example
A user signs in through a shop's company provider while that shop has a free seat under its [`STARTER` plan](plan-limit.md). They become a member with `source: sso` and the provider's default role (for example `STAFF`, illustrative). If the shop were suspended or closing, no member would be created.

## Known gaps
- The spec does not say what the user sees when provisioning is skipped, for example when no seat is free or the shop is not `ACTIVE`.
- The name is close to `ShopProvisioningService`, but the facts do not say whether that service does this work. Not confirmed in the code: the code facts point to `SsoProvisioningService` for this behaviour.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-26
- [federated-identity-linked-event](federated-identity-linked-event.md)
- [plan-limit](plan-limit.md)
- [provider-default-role](provider-default-role.md)
- [seat](seat.md)
<!-- used-by:end -->
