---
id: subject-extractor
title: Subject extractor
kind: term
status: draft
aliases: [extractor]
defined_for: S50-rate-limiter
rules_hash: dd20b25515cf
---
# Subject extractor
## Definition
A subject extractor is the part of a [policy](rate-limit-policy.md) that reads a request and returns its [rate limit subject](rate-limit-subject.md). That subject can be the [resolved client address](client-address.md), a user, an API key, a shop, or a hashed e-mail. Personal values are hashed, so the store never holds the raw value. If the policy's identity is missing, the client address is used and the [fallback counter](rate-limit-subject-fallback.md) goes up. If the extractor throws, the policy's [fail mode](rate-limit-fail-mode.md) decides, never a raw `500`.

## Example
A login policy keyed by e-mail turns `" Alice@Example.COM "` and `"alice@example.com"` into the same hashed subject. If a shop policy gets a request with no shop, it falls back to the client address and `rate_limit_subject_fallback_total` goes up.

## Known gaps
- The spec does not state the subject length limit as a rule. It is only covered by a scenario (AS-53).
- The spec does not say how an extractor is declared on a policy (field name or signature).

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-20
- [client-address](client-address.md)
- [rate-limit-decorator](rate-limit-decorator.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject-fallback](rate-limit-subject-fallback.md)
- [rate-limit-subject](rate-limit-subject.md)
<!-- used-by:end -->
