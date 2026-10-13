---
id: secret-set
title: secretSet
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# secretSet
## Definition
`secretSet` is a field in the answer to [`GET /shops/:shopId/sso`](get-shop-sso.md). It tells the [owner](shop-role.md) whether a [client secret ↗](../sw-external-terms.md#oauth-client-secret) is stored for the shop's [identity provider ↗](../sw-external-terms.md#identity-provider). The real secret is never returned; this field is the only sign that one exists. Design intent (not stated in the spec): an owner can confirm the setup is complete without the secret ever leaving the server.

## Example
An owner reads the SSO configuration of their shop (illustrative values):
```json
{ "issuer": "https://login.example.com", "clientId": "abc123", "defaultRole": "STAFF", "secretSet": true }
```

## Known gaps
- The spec does not say the type of `secretSet`. The name suggests a boolean, but this is not confirmed in the code.
- The spec does not say whether `secretSet` can ever be false on a stored configuration, for example after a failed reseal by [`tenancy.reseal-sso-secrets`](reseal-sso-secrets-job.md).

## Used by
<!-- used-by:start -->
- [shop-role](shop-role.md)
<!-- used-by:end -->
