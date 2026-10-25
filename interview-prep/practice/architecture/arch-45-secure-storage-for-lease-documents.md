# arch-45. Secure storage for lease documents

*Security · Easy*

## The question

"Landlords upload lease contracts (PDF, up to 25 MB); tenants upload ID documents and pay stubs. About 50k uploads a month. Only the landlord, the tenants on that lease, and support staff with a recorded reason may view a document. Design upload, storage, access control and malware scanning."

**Then:** "A landlord wants to email a link to the lease to a guarantor who has no account with us."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Allowed file types? → assume: PDF, JPEG, PNG only.
- Retention? → assume: contracts kept for a legal period after the lease ends (length depends on jurisdiction, e.g. 7 years); ID documents deleted once verification and its required retention are done.
- Audit? → assume: every view is logged with who, when and why.
- Encryption requirements? → assume: SSE-KMS with our customer-managed key.
- Support access? → assume: role-based, requires a ticket reference, logged.
- Inline viewing in the browser? → assume: download or open via the browser's PDF viewer; never served as HTML.

## Design

**Upload**
1. `POST /documents { leaseId, kind, filename, size, contentType }` → API checks the caller may attach to this lease, inserts a `documents` row (`pending_upload`), returns a **presigned POST** for `quarantine/{doc_id}` with policy conditions: `content-length-range` 1 B-25 MB, fixed `Content-Type`, 5-minute expiry.
2. The browser uploads straight to S3; the file never passes through Node.
3. S3 event → scanner: GuardDuty Malware Protection for S3 (managed; can tag the object with the scan result when tagging is enabled) or ClamAV in a Lambda/ECS task. Also check magic bytes match the declared type.
4. Clean → copy to `docs/{doc_id}`, delete from quarantine, status `available`, store `sha256`. Infected or wrong type → `rejected`, delete, tell the uploader.

**Storage:** private bucket, Block Public Access on, SSE-KMS with S3 Bucket Keys (fewer KMS calls), bucket policy denying non-TLS requests and any principal except the app and scanner roles, versioning on, lifecycle rules for retention and for deleting old versions. Signed contracts can use Object Lock (governance mode) for their retention period.

**Download**
`GET /documents/:id/download` → permission check (lease membership or support role + reason) → insert into `document_access_log` → return a presigned GET valid 60 s with `response-content-disposition=attachment` and a fixed `response-content-type`.

```sql
documents(id uuid PRIMARY KEY, lease_id uuid, owner_user_id uuid, kind text,  -- lease | id_doc | pay_stub
          s3_key text, sha256 bytea, size_bytes int, content_type text,
          status text,                     -- pending_upload | scanning | available | rejected | deleted
          uploaded_by uuid, created_at, retain_until date)
document_access_log(document_id, actor_id, actor_role, reason text, ip inet, at timestamptz)
```
Permissions live in Postgres next to the lease, not in S3 keys or IAM.

## Deep dives

**1. Presigned URLs are bearer tokens.** Anyone holding the URL can use it until it expires, and one URL can't be revoked on its own. So: short expiry (60 s for downloads), created only after the permission check and audit write, never stored or emailed. Limits to know: with SigV4 the maximum expiry is 7 days, and a URL signed with temporary role credentials stops working when those credentials expire, even if its own expiry is later. Rejected: streaming every download through Node (memory, bandwidth, timeouts) unless we need per-byte control such as watermarking.

**2. Quarantine before anything can read it.** We redistribute files between landlords, tenants and staff, so we must not serve malware or active content. Unscanned objects sit under a prefix no download path can reach. Content type is decided by us, not by the uploader, and files are served as attachments, so an uploaded HTML or SVG can't run script on our domain.

**3. Where authorization lives.** Rejected: one IAM principal or S3 prefix per user. It doesn't match the domain (access follows lease membership, which changes), and IAM policies have size limits. The app decides; S3 only trusts the app's role.

## Traps

- Public bucket, or long-lived presigned URLs in emails.
- Proxying 25 MB uploads through the API servers.
- Trusting the client's `Content-Type` or file extension.
- Serving uploads inline from our main domain: stored XSS via HTML/SVG.
- "Security" through unguessable object keys instead of a permission check.
- Making a document downloadable before the scan finishes.

## Say it (60–90 s)

Uploads go straight from the browser to S3. The API first checks the user can attach to that lease, creates a document row, and returns a presigned POST that only allows our content types, up to 25 megabytes, into a quarantine prefix, valid for five minutes. An S3 event triggers a malware scan, GuardDuty's S3 malware protection or ClamAV, plus a magic-bytes check. Clean files move to the documents prefix and become available; anything else is rejected and deleted. The bucket is private with Block Public Access, encrypted with our KMS key, TLS-only, versioned, with lifecycle rules for retention, and Object Lock for signed contracts. Permissions live in Postgres next to the lease, not in S3. To download, the API checks the user is the landlord, a tenant on the lease, or support with a reason, writes an access log row, and returns a presigned GET valid for about a minute, forced to download as an attachment with our content type. Presigned URLs are bearer tokens and can't be revoked individually, so I keep them short and never email them.

## Follow-ups

**Q:** Then: a link for a guarantor with no account?
**A:** Not a presigned S3 URL in an email. Create a share: `document_shares(token_hash, document_id, email, expires_at = now() + 72h, max_views, created_by, revoked_at)`. The email links to our page; the guarantor confirms a one-time code sent to that email; then we issue a 60-second presigned URL and log the access. The landlord can revoke it. Only the lease is shareable this way, never a tenant's ID documents.

**Q:** How do you delete an ID document for good when versioning is on?
**A:** Delete every version, not just the current one (a plain delete only adds a delete marker), and mark the row `deleted`. Don't put ID documents under Object Lock compliance mode: nobody, including the root user, can delete them before retention ends.

**Q:** Why SSE-KMS and not SSE-S3?
**A:** KMS gives a key policy we control and a CloudTrail record of decrypts. It costs per request; S3 Bucket Keys cut the number of KMS calls a lot.

</details>

## Theory in the notes

- [05-security/01-web-security-xss-csrf-csp.md](../../05-security/01-web-security-xss-csrf-csp.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
