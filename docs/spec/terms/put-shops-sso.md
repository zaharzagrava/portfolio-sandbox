---
id: put-shops-sso
title: PUT /shops/:shopId/sso
kind: term
status: draft
aliases: [/shops/:shopid/sso]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# PUT /shops/:shopId/sso
## Definition
The owner of a shop calls this endpoint to set up the shop's own [identity provider ↗](../sw-external-terms.md#identity-provider), so staff can use company sign-in. Only an [`OWNER`](shop-role.md) may call it. Before anything is saved, the system checks the provider's [issuer](oidc-issuer.md) and fetches its [discovery document ↗](../sw-external-terms.md#oidc-discovery-document) once. If any check fails, the endpoint answers with one of the [SSO issuer errors](sso-issuer-errors.md) and stores nothing. The [client secret ↗](../sw-external-terms.md#oauth-client-secret) is stored [sealed](secret-box.md) and never appears in any response, including the answer from `GET /shops/:shopId/sso`.

## Example
The owner of a shop sends `PUT /shops/:shopId/sso` with the issuer `https://login.acme.example` (illustrative). That issuer's discovery document names the same issuer, so the configuration is saved and the secret is sealed with the [context `shop-sso:<shopId>`](seal-context.md). Later, a user who signs in through this provider becomes a member with [`source: sso`](membership-removal-source.md) and the [provider default role](provider-default-role.md).

## Known gaps
- The spec does not list the request body fields or the success status code. The rules only imply an issuer, a client secret, an enabled flag and a default role.
- The spec does not say which error a member who is not an `OWNER` receives (`permission_denied` or `insufficient_role`). It also does not say whether a [`SUSPENDED`](shop-status.md) shop refuses this call with `shop_suspended`. Under the [allowed-permissions rule for suspended shops](shop-status-gate.md) it most likely does, but that is inferred.
- The spec does not say whether a second `PUT` replaces the whole configuration, or what happens to the stored secret if a `PUT` leaves it out.

## Used by
<!-- used-by:start -->
- [oidc-issuer](oidc-issuer.md)
- [provider-default-role](provider-default-role.md)
- [seal-context](seal-context.md)
- [secret-box](secret-box.md)
- [shop-status-gate](shop-status-gate.md)
- [sso-issuer-errors](sso-issuer-errors.md)
<!-- used-by:end -->
