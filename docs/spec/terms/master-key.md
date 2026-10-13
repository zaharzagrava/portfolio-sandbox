---
id: master-key
title: Master key for secret sealing
kind: term
status: draft
aliases: [master key]
defined_for: S01-auth-sessions
rules_hash: 9f2057fcee1f
---
# Master key for secret sealing
## Definition
The master key for secret [seal](secret-box.md)ing is a configuration value owned by [S01](../capabilities/S01-auth-sessions.md). The [identity domain](identity-domain.md) uses it to seal secrets, meaning it encrypts them before storage so they can be opened again later. The spec lists it only under configuration. It does not name the component that reads it. Keeping the key in configuration means it is never stored next to the sealed data. This is design intent (not stated in the spec).

## Example
S01's configuration lists the master key next to its other settings:
```
master key for secret sealing, [trusted proxies](trusted-proxy.md), audience allowlist, front-end origin allowlist
```
Illustrative: [`SecretBox`](secret-box.md) is likely the component that uses this key, but its name is the only evidence for that.

## Known gaps
- The spec does not say the name of the setting or environment variable that holds the master key, or how it is supplied.
- The spec does not say which component reads the key. The link to `SecretBox` comes from the names only.
- The spec does not say how the key is rotated, or what happens to values sealed under an old key.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-36
- [identity-domain](identity-domain.md)
- [reseal-sso-secrets-job](reseal-sso-secrets-job.md)
- [secret-box-context](secret-box-context.md)
- [secret-box](secret-box.md)
<!-- used-by:end -->
