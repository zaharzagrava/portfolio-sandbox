---
id: sliding-window-estimate
title: Sliding-window usage estimate
kind: term
status: draft
aliases: [estimate]
defined_for: S50-rate-limiter
rules_hash: 09da88c1b124
---
# Sliding-window usage estimate
## Definition
The sliding-window estimate is how a [sliding-window policy](rate-limit-policy.md) guesses a [subject](rate-limit-subject.md)'s usage over the last [`windowMs`](window-ms.md). It takes the previous window's count, weighted by how much of that window still overlaps, and adds the current window's count. A request is [admitted](connection-admission.md) only if one more request still fits within the limit. Only admitted requests are counted, so denied retries do not push the subject further over. All of the time values come from the [store clock](store-clock.md).

## Example
Say the limit is 10 and `windowMs` is 60000. The previous window counted 10, 30 s of the current window have passed, and the current window has counted 4. The estimate is `10 × (1 − 30000 ÷ 60000) + 4 = 9`, and `9 + 1 ≤ 10`, so the request is admitted (illustrative values).
Unlike a [fixed window ↗](../sw-external-terms.md#sliding-window), 10 requests at the end of one window followed by 10 at the start of the next are not all admitted (B-04).

## Known gaps
- The spec does not say how [a cost above one](rate-limit-cost.md) interacts with the estimate. The admission check is written for a single request.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-08
- [connection-admission](connection-admission.md)
- [hash-tag](hash-tag.md)
- [rate-limit-cost](rate-limit-cost.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject](rate-limit-subject.md)
- [store-clock](store-clock.md)
<!-- used-by:end -->
