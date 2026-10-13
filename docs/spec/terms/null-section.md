---
id: null-section
title: Null section
kind: term
status: draft
aliases: [null sections]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# Null section
## Definition
A null section is an optional section of the page aggregate whose value is `null` instead of data. It happens in two cases. When the section does not apply, there is no upstream call and no errors entry. When the section failed, there is one errors entry that names the section and gives an error code. The other sections stay intact, and the page still answers 200. The required product section is never null: if the product fails, the whole page fails.

## Example
Recommendations answer after 500 ms, but their own budget is 300 ms:
```json
{
  "product": { "...": "..." },
  "recommendations": null,
  "errors": [{ "section": "recommendations", "code": "UPSTREAM_TIMEOUT", "retryable": true }]
}
```
(The `retryable` value is illustrative.) An anonymous visitor gets `"chatUnread": null` with no errors entry, because chat does not apply to them.

## Known gaps
- The spec does not say which codes are `retryable: true`. It only says the errors entry has the members `{section, code, retryable}`.

## Used by
<!-- used-by:start -->
- [product-page-endpoint](product-page-endpoint.md)
<!-- used-by:end -->
