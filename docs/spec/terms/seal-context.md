---
id: seal-context
title: Seal context
kind: term
status: draft
aliases: [sealing context]
defined_for: S03-shops-rbac
rules_hash: 14f6e2140341
---
# Seal context
## Definition
The seal context is the label `shop-sso:<shopId>`. The system binds this label to a shop's [SSO client secret](shop-sso-config.md) when it seals the secret with the [SecretBox](secret-box.md). The secret is stored only in [sealed](secret-box.md) form and never appears in a response. It is unsealed only when the [sign-in registry](oidc-provider-registry.md) resolves that shop's provider during a login. Putting the shop id in the context probably ties a sealed secret to its own shop, so a secret copied into another shop's row would not unseal. That reason is design intent (not stated in the spec).

## Example
For shop `7f3c…` (illustrative id), the client secret is sealed with the context `shop-sso:7f3c…`. The daily job `tenancy.reseal-sso-secrets` seals stored secrets again and is [idempotent ↗](../sw-external-terms.md#idempotency).

## Known gaps
- Not confirmed in the code: which sealing primitive is used, and whether a wrong context makes unsealing fail or only changes the result.
- The spec does not say what triggers resealing, for example a rotation of the master key.

## Used by
<!-- used-by:start -->
- [oidc-provider-registry](oidc-provider-registry.md)
- [put-shops-sso](put-shops-sso.md)
- [reseal-sso-secrets-job](reseal-sso-secrets-job.md)
- [secret-box-context](secret-box-context.md)
- [secret-box](secret-box.md)
- [shop-sso-config](shop-sso-config.md)
<!-- used-by:end -->
