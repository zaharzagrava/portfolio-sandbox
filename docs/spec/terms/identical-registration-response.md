---
id: identical-registration-response
title: Identical registration response
kind: term
status: draft
aliases: [byte-identical]
defined_for: S01-auth-sessions
rules_hash: 825fc0c6d7ec
---
# Identical registration response
## Definition
[`POST /auth/register`](post-auth-register.md) returns the same response whether the address is new or already registered: [`202 {"status":"accepted"}` ↗](../sw-external-terms.md#http-202-accepted). The response is byte-identical in both cases. It never creates a session or returns tokens. In both cases the service also does the same slow one-way scrambling of a password exactly once, so response time does not differ either. According to the spec, this keeps both the response and the latency from revealing whether an account exists.

## Example
Registering `" New@Example.COM "` and later registering `"new@example.com"` both return:
```
HTTP/1.1 202
{"status":"accepted"}
```
The second request leaves the account unchanged and emits [`identity.registration_duplicate_attempted`](registration-duplicate-attempted-event.md).

## Known gaps
- The spec does not say how the owner of an existing address is told that someone tried to register it, for example by email.
- The spec does not say whether response headers such as [`requestId` or `X-Request-Id`](request-id.md) differ between the two requests. "Byte-identical" presumably refers to the body and status code.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-02
- [S13](../capabilities/S13-payment-intents.md): B-02
- [S34](../capabilities/S34-recommendations.md): R-08
- [S35](../capabilities/S35-trending.md): R-06
- [W01](../capabilities/W01-auth-account.md): R-08, B-02
- [normalize-email](normalize-email.md)
- [password-hash](password-hash.md)
- [post-auth-register](post-auth-register.md)
- [query-suggestion](query-suggestion.md)
- [query-suggestions](query-suggestions.md)
- [register-page](register-page.md)
- [registration-duplicate-attempted-event](registration-duplicate-attempted-event.md)
- [request-id](request-id.md)
<!-- used-by:end -->
