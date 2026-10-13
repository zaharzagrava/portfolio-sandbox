---
id: membership-removal-source
title: Membership removal source
kind: term
status: draft
aliases: [source, sso]
defined_for: S03-shops-rbac
rules_hash: 804f5dac9378
---
# Membership removal source
## Definition
The removal source is a label recorded when a member is removed from a shop. It says what started the removal. When the source is `sso`, the member's [sessions are revoked](session-revocation.md) with reason [`shop_membership_removed`](session-revocation.md) [once the removal commits](after-commit-callback.md). Design intent (not stated in the spec): if the company's [identity provider ↗](../sw-external-terms.md#identity-provider) has dropped the person, they should lose access right away and not keep it until their session expires.

## Example
The shop's identity provider reports that a person has left. Their membership is removed with source `sso`. After commit, their sessions are revoked with reason `shop_membership_removed`.

## Known gaps
- The spec does not list the other source values, for example for a manual removal or a member leaving.
- The spec does not say whether removals from other sources also revoke sessions.
- Not confirmed in the code: where the source is stored, for example on the `tenancy.member_removed` event.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-08
- [after-commit-callback](after-commit-callback.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
