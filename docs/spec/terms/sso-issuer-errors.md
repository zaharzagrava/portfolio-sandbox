---
id: sso-issuer-errors
title: SSO issuer errors
kind: term
status: draft
aliases: [sso_issuer_invalid, sso_issuer_mismatch, sso_issuer_unreachable]
defined_for: S03-shops-rbac
rules_hash: 982f695e3f24
---
# SSO issuer errors
## Definition
These are the three [`422` ↗](../sw-external-terms.md#http-422-unprocessable-content) error codes for an [SSO configuration](shop-sso-config.md) whose [issuer ↗](../sw-external-terms.md#jwt-iss) fails its checks: `sso_issuer_invalid`, `sso_issuer_mismatch` and `sso_issuer_unreachable`. They are returned when an owner calls [`PUT /shops/:shopId/sso`](put-shops-sso.md). The issuer must be an `https` URL on a [public address](blocked-address.md). Its [discovery document ↗](../sw-external-terms.md#oidc-discovery-document) must name the same issuer. When any check fails, the system stores nothing. The discovery document is fetched outside any transaction, likely so that a slow provider cannot keep a database transaction open. That reason is design intent (not stated in the spec).

## Example
An owner of shop `acme` (illustrative) sets the issuer `https://login.acme.example` (illustrative). That issuer's discovery document says `"issuer": "https://other.example"` (illustrative). The answer is `422 sso_issuer_mismatch`, and the shop keeps its previous SSO configuration or none.

## Known gaps
- The spec does not say exactly which failed check gives which code. Reading the names, a non-`https` or non-public URL gives `sso_issuer_invalid`, a different issuer in the document gives `sso_issuer_mismatch`, and a fetch timeout or error gives `sso_issuer_unreachable`. This mapping is inferred.
- The spec does not say whether a later sign-in checks the issuer again, or whether the check runs only when the configuration is saved.

## Used by
<!-- used-by:start -->
- [blocked-address](blocked-address.md)
- [put-shops-sso](put-shops-sso.md)
- [shop-sso-config](shop-sso-config.md)
<!-- used-by:end -->
