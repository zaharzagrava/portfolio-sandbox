---
id: reseal-sso-secrets-job
title: tenancy.reseal-sso-secrets job
kind: term
status: draft
aliases: [reseal, tenancy.reseal-sso-secrets]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# tenancy.reseal-sso-secrets job
## Definition
`tenancy.reseal-sso-secrets` is a scheduled [tenancy job](tenancy-domain-layer.md) that works on the stored [client secrets](client-secret.md) of [shop identity providers](shop-sso-config.md). Those secrets are kept [sealed](secret-box.md) with the [seal context](seal-context.md) `shop-sso:<shopId>`. Going by its name, the job seals each secret again. One likely reason is to move secrets onto a newer [master key](master-key.md). That is design intent (not stated in the spec). The job is [idempotent ↗](../sw-external-terms.md#idempotency): if it runs again, or runs twice, nothing changes beyond what one run does.

## Example
The [scheduler](scheduler-tick.md) runs `tenancy.reseal-sso-secrets` once a day. Shop `shop_42` (illustrative) has its client secret sealed under `shop-sso:shop_42`. After the run, the secret is still sealed under the same context. The secret never appears in `GET /shops/:shopId/sso`, which still shows `[secretSet: true](secret-set.md)`.

## Known gaps
- The spec does not say what the job does in detail: which key it seals with, which rows it chooses, or what makes a secret due for resealing.
- The spec does not say what happens if resealing fails for one shop. It also does not say whether that shop's company sign-in keeps working.
- Not confirmed in the code: which class registers this job. The only code reference given is `PurgeShopsJobs` in `purge-shops.jobs.ts`.

## Used by
<!-- used-by:start -->
- [client-secret](client-secret.md)
- [master-key](master-key.md)
- [scheduler-tick](scheduler-tick.md)
- [seal-context](seal-context.md)
- [secret-box](secret-box.md)
- [shop-sso-config](shop-sso-config.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
