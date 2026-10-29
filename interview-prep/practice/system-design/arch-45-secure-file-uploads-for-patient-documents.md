# arch-45. Secure file uploads for patient documents

*Security · Easy*

## The question

"On our healthcare scheduling platform, patients upload insurance card photos and referral letters, and clinics upload lab result PDFs (up to 25 MB). About 50k uploads a month. Only the patient, staff at the clinic treating them, and support staff with a recorded reason may view a file. Design upload, storage, access control, malware scanning and the image processing for thumbnails."

**Then:** "A clinic wants to send a lab result to an outside specialist who has no account with us."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Allowed file types? → assume: PDF, JPEG, PNG, and HEIC from iPhones.
- Retention? → assume: medical records kept for a legal period that depends on country and state; insurance photos replaced when the card changes.
- Regulation? → assume: US patients, so HIPAA: use only HIPAA-eligible AWS services under a BAA, and check the eligible-services list for each one we add.
- Audit? → assume: every view is logged with who, when and why.
- Encryption? → assume: SSE-KMS with our customer-managed key.
- Viewing? → assume: images inline as thumbnails in our app; PDFs downloaded or opened in the browser's viewer; never served as HTML.

## Design

**Upload**
1. `POST /files { patientId, kind, filename, size, contentType }` → the API checks the caller may attach to this patient, inserts a `files` row (`pending_upload`), and returns a **presigned POST** for `quarantine/{file_id}` with policy conditions: `content-length-range` 1 B-25 MB, fixed `Content-Type`, 5-minute expiry.
2. The browser uploads straight to S3; the file never passes through Node.
3. S3 event → scanner: GuardDuty Malware Protection for S3 (managed; can tag the object with the scan result) or ClamAV in an ECS task. Also check that magic bytes match the declared type.
4. Clean → an image worker (sharp) converts HEIC to JPEG, **strips EXIF metadata** (phone photos carry GPS location), auto-rotates, and writes a 400 px thumbnail; PDFs get a first-page preview. Originals go to `files/{file_id}`, quarantine is deleted, status `available`, `sha256` stored. Infected or wrong type → `rejected`, deleted, the uploader is told.

**Storage:** a private bucket with Block Public Access, SSE-KMS with S3 Bucket Keys (fewer KMS calls), a bucket policy denying non-TLS requests and every principal except the app, scanner and worker roles, versioning on, lifecycle rules for retention and old versions.

**Download**
`GET /files/:id/download` → permission check (patient, active care relationship at the clinic, or support role + reason) → insert into `file_access_log` → return a presigned GET valid 60 s with `response-content-disposition=attachment` and a fixed `response-content-type`.
```sql
files(id uuid PRIMARY KEY, patient_id uuid, clinic_id uuid, kind text,  -- insurance_card | referral | lab_result
      s3_key text, thumb_key text, sha256 bytea, size_bytes int, content_type text,
      status text,                 -- pending_upload | scanning | available | rejected | deleted
      uploaded_by uuid, created_at timestamptz, retain_until date)
file_access_log(file_id, actor_id, actor_role, reason text, ip inet, at timestamptz)
```
Permissions live in Postgres next to the care relationship, not in S3 keys or IAM.

## Deep dives

**1. Presigned URLs are bearer tokens.** Anyone holding the URL can use it until it expires, and a single URL can't be revoked. So: short expiry (60 s for downloads), created only after the permission check and the audit write, never stored or emailed. Limits to know: with SigV4 the maximum expiry is 7 days, and a URL signed with temporary role credentials stops working when those credentials expire, even if its own expiry is later. Rejected: streaming every download through Node (memory, bandwidth, timeouts) unless we need per-byte control such as watermarking.

**2. Quarantine before anything can read it.** Files move between patients, clinics and staff, so we must not serve malware or active content. Unscanned objects sit under a prefix no download path can reach. The content type is decided by us, not the uploader, and files are served as attachments, so an uploaded HTML or SVG can't run script on our domain. Image processing runs only after the scan, in a separate worker with a memory limit, because image decoders are a classic attack surface.

**3. Where authorization lives.** Rejected: one IAM principal or S3 prefix per user. It doesn't match the domain (access follows care relationships, which change), and IAM policies have size limits. The app decides; S3 only trusts the app's roles.

## Traps

- A public bucket, or long-lived presigned URLs in emails.
- Proxying 25 MB uploads through the API servers.
- Trusting the client's `Content-Type` or file extension.
- Keeping EXIF data on patient photos: it can include the GPS location of their home.
- Serving uploads inline from our main domain: stored XSS via HTML or SVG.
- Making a file downloadable before the scan finishes.

## Say it (60–90 s)

Uploads go straight from the browser to S3. The API first checks the user can attach files to that patient, creates a file row, and returns a presigned POST that only allows our content types, up to twenty-five megabytes, into a quarantine prefix, valid for five minutes. An S3 event triggers a malware scan, GuardDuty's S3 malware protection or ClamAV, plus a magic-bytes check. Clean images go through a worker that converts HEIC, strips EXIF metadata, because phone photos carry GPS location, and makes a thumbnail. Then the file becomes available; anything else is rejected and deleted. The bucket is private with Block Public Access, encrypted with our KMS key, TLS-only and versioned, with lifecycle rules for retention. Permissions live in Postgres next to the care relationship, not in S3. To download, the API checks the user is the patient, staff at a treating clinic, or support with a reason, writes an access log row, and returns a presigned GET valid for about a minute, forced to download with our content type. Presigned URLs are bearer tokens and can't be revoked individually, so I keep them short and never email them.

## Follow-ups

**Q:** Then: a lab result for a specialist with no account?
**A:** Not a presigned S3 URL in an email. Create a share: `file_shares(token_hash, file_id, recipient_email, expires_at = now() + 72h, max_views, created_by, revoked_at)`. The email links to our page; the specialist confirms a one-time code sent to that address; then we issue a 60-second presigned URL and log the access. The clinic can revoke it. Only clinic staff can create shares, only for files of their own patients.

**Q:** How do you delete a file for good when versioning is on?
**A:** Delete every version, not just the current one (a plain delete only adds a delete marker), delete the thumbnail too, and mark the row `deleted`. Don't put such files under Object Lock compliance mode: nobody, including the root user, could delete them before retention ends.

**Q:** Why SSE-KMS and not SSE-S3?
**A:** KMS gives a key policy we control and a CloudTrail record of decrypt calls. It costs per request; S3 Bucket Keys cut the number of KMS calls a lot.

</details>

## Theory in the notes

- [05-security/01-web-security-xss-csrf-csp.md](../../05-security/01-web-security-xss-csrf-csp.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [10-system-design/08-media-and-files.md](../../10-system-design/08-media-and-files.md)
