---
id: invite-purge-job
title: Invite purge job
kind: term
status: draft
aliases: [invite purge]
defined_for: S03-shops-rbac
rules_hash: 2f0810271f40
---
# Invite purge job
## Definition
The invite purge job is the [scheduled job](job.md) `tenancy.purge-expired-[invites](pending-invite.md)`. It deletes invites that ended long enough ago, whether they expired, were [revoked](invite-revoke.md) or were [accepted](invite-acceptance.md). It deletes the invited email addresses together with those invites. Invites that are still [pending](pending-invite.md), or that ended too recently, are left alone. Design intent (not stated in the spec): it stops personal data from building up forever in the invite table.

## Example
On a daily run, an invite that was revoked 31 days ago is deleted along with its address. An invite accepted 10 days ago stays (both ages are illustrative; the rule uses 30 days past the end event).

## Known gaps
- The spec does not say whether the job processes invites in [batches](bounded-batch.md) or retries after a failure.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-27
- [bounded-batch](bounded-batch.md)
- [invite-acceptance](invite-acceptance.md)
- [invite-revoke](invite-revoke.md)
- [job](job.md)
- [pending-invite](pending-invite.md)
- [tenancy-purge-deleted-shops-job](tenancy-purge-deleted-shops-job.md)
<!-- used-by:end -->
