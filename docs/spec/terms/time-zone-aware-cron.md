---
id: time-zone-aware-cron
title: Time-zone-aware cron
kind: term
status: draft
aliases: [cron]
defined_for: idempotency-key
rules_hash: 3f3fcf426380
---
# Time-zone-aware cron
## Definition
Time-zone-aware cron means [S49](../capabilities/S49-job-scheduler.md) reads a [cron schedule ↗](../sw-external-terms.md#cron-expression) in a named time zone instead of the server's own clock zone. A job set for a local hour then fires at that local hour, including after [daylight-saving changes ↗](../sw-external-terms.md#daylight-saving-time). The S49 capability title names it, but the spec gives no rule for it. Design intent (not stated in the spec): business tasks such as daily reports should follow the user's or shop's local day, not UTC.

## Example
The schedule `0 9 * * *` with the zone `Europe/Kyiv` (both illustrative) fires at 09:00 Kyiv time every day. It keeps doing so on both sides of a daylight-saving change, even though the UTC time it fires at moves by an hour.

## Known gaps
- The spec does not say how S49 handles an hour that is skipped or repeated when daylight saving starts or ends.
- The spec does not say how the zone is given, for example as an [IANA name ↗](../sw-external-terms.md#iana-time-zone) or an offset, or which zone is used when none is given.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-19
- [jobs-partition-maintenance](jobs-partition-maintenance.md)
- [schedule-enabled](schedule-enabled.md)
- [search-retire-previous-index](search-retire-previous-index.md)
<!-- used-by:end -->
