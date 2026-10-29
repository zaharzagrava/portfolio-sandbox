# arch-08. File storage and sync for business teams

*Storage · Medium*

## The question

"Design a Dropbox-style file sync product for businesses: desktop and mobile clients keep a folder in sync, files can be shared with teammates, and old versions are kept for 180 days. 2M users across 50k companies, 1M daily active, ~5 GB per user on average, files up to 50 GB. Edits made offline must sync when the device reconnects."

**Then:** "Two people edit the same 200 MB spreadsheet offline on a flight and both reconnect after landing. And a user renames a shared folder that contains 100k files."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Real-time co-editing inside files? → assume: no; we sync whole files. Co-editing is a different product (arch-21).
- Dedupe across companies? → assume: no, only within a company (security, deep dive 3).
- Version history? → assume: every committed version for 180 days, then only the latest.
- Latency for a change to reach teammates? → assume: seconds when both are online.
- Numbers → assume: 2M × 5 GB = 10 PB logical; ~30% saved by in-company dedupe → ~7 PB in S3. At 4 MB blocks that's ~2B objects. File changes: 1M DAU × 30/day = 30M/day ≈ 350/s avg, ~2k/s peak. If an average change uploads ~2 MB of new blocks, that's ~60 TB/day in (~5.5 Gbps avg).
- Metadata → assume: ~3k files per user, shared folders counted once → several billion file rows at ~500 B = a few TB. Too big for one Postgres; shard by namespace.

## Design

**Concepts.** A **namespace** = a user's private root or one shared folder. Each has its own journal. A shared folder is mounted into each member's tree.

**1. Metadata** (Postgres, sharded by `namespace_id`)
```sql
nodes(namespace_id, node_id, parent_id, name, kind,     -- file | folder
      current_rev bigint, deleted bool, PRIMARY KEY (namespace_id, node_id),
      UNIQUE (namespace_id, parent_id, name))
file_revs(namespace_id, node_id, rev, size, block_hashes bytea[], author_id, created_at)
journal(namespace_id, seq bigint, node_id, op, rev, PRIMARY KEY (namespace_id, seq))
blocks(company_id, sha256 bytea, size, s3_key, PRIMARY KEY (company_id, sha256))
```

**2. Upload / commit.**
1. Client splits the file into 4 MB blocks and hashes each with SHA-256.
2. `POST /commit {namespace, node, parentRev, blockHashes}` → server answers with the hashes it doesn't have for this company.
3. Client uploads missing blocks in parallel to presigned S3 PUT URLs (`s3_key = company/sha256`).
4. Client re-sends commit; server checks all blocks exist, then one transaction on the namespace shard: check `current_rev = parentRev`, insert `file_revs`, update `nodes.current_rev`, append `journal` (`seq = max + 1`).

**3. Download / sync.** Each client keeps a cursor (`seq`) per namespace. A long-poll or WebSocket `/notify` returns "namespace X changed"; the client calls `GET /delta?ns=X&cursor=N` → journal entries after N, then fetches only blocks it doesn't have locally (CloudFront signed URLs in front of S3).

**4. Offline.** Client records local changes with the `rev` they were based on, and replays them as commits on reconnect.

**5. Versions and GC.** Old `file_revs` expire after 180 days. Blocks are deleted by mark-and-sweep per company (blocks not referenced by any live rev, older than 7 days), never by a decrement-on-delete refcount that drifts after a crash.

**6. Sharing.** `mounts(user_id, namespace_id, path_in_root, role)`; every API call checks role on the namespace. Share links = random token → (namespace, node, rev or latest), expiry, optional password.

## Deep dives

**1. Conflicts (twist, part 1).** Both clients commit with `parentRev = 7`. The first wins (rev 8). The second fails the `current_rev = parentRev` check; the server returns the conflict, and the client commits its version as a new file `Budget (Dana's conflicted copy 2026-10-27).xlsx`. Nothing is lost, a human merges. Blocks shared between the two versions are not uploaded twice. Rejected: last-writer-wins (silently drops one person's flight of work); automatic merge (impossible for binary formats in general).

**2. Rename a folder with 100k files (twist, part 2).** With full paths stored per file, the rename is 100k row updates and 100k journal entries, and clients see a half-renamed tree mid-way. With parent pointers it's one row: `UPDATE nodes SET name = ... WHERE node_id = folder`, plus one journal entry `move/rename`. Clients apply it to their local tree; paths are computed, not stored. Chosen: parent pointers and an `(namespace, parent_id, name)` uniqueness constraint. Cost: "list by path" needs a walk, cached in the client.

**3. Block size and dedupe safety.** Fixed 4 MB blocks: an insert near the start of a file shifts every later block, so the whole file re-uploads. Content-defined chunking (rolling hash, FastCDC) fixes that for formats that change in place, but most Office files are ZIP-compressed and change throughout anyway. Chosen: fixed 4 MB first, CDC if measurements show re-upload waste. Dedupe trap: if the server skips upload because "a block with this hash exists", anyone who learns a hash gets the content, and anyone can test whether a file exists. Chosen: skip upload only for blocks already referenced by namespaces this user can read; other "known" blocks are uploaded and deduped server-side. Rejected: global cross-company dedupe.

**4. Large files.** 50 GB = 12,800 blocks; clients upload 4-8 in parallel with resume per block, so a dropped connection costs at most one block.

## Traps

- Storing whole files per version: a 1-byte edit to a 1 GB file stores another 1 GB and uploads it.
- Full paths as the primary key: renames and moves of large folders become massive rewrites.
- Last-writer-wins on conflicts: silent data loss is the one thing a sync product can't do.
- Global hash-based dedupe that trusts the client's hash: leaks file contents and existence across customers.
- Clients polling `/delta` for every namespace every few seconds: 1M clients × N namespaces. Use one long-poll/notify connection and fetch deltas only on change.
- Deleting blocks the moment a file is deleted: version restore and in-flight commits still reference them.

## Say it (60–90 s)

Files are split into four-megabyte blocks, hashed with SHA-256, and stored in S3 by company and hash, so unchanged blocks are never uploaded twice. Metadata lives in Postgres sharded by namespace, where a namespace is a user's root or one shared folder. A commit sends the block list; the server answers with the hashes it's missing, the client uploads those through presigned URLs, and then one transaction checks the parent revision, writes the new revision and appends a journal entry. Clients hold a cursor per namespace, get a notification when something changes, pull the journal delta and download only missing blocks. For the spreadsheet edited on a flight, the second commit fails the parent-revision check, and the client saves its version as a conflicted copy, so nothing is lost and a person merges. For the folder rename, I store parent pointers rather than full paths, so renaming a folder of a hundred thousand files is one row update and one journal entry. Dedupe stays within a company, and the client can skip uploading a block only if it can already read a file that contains it, otherwise knowing a hash would be enough to steal a file.

## Follow-ups

**Q:** How do you keep the desktop client from re-hashing 100k files on every start?
**A:** It stores (path, size, mtime, inode, hashes) locally and only re-hashes files whose size or mtime changed, plus OS file-watch events (FSEvents, inotify, ReadDirectoryChangesW) while running.

**Q:** How do you handle a shard that holds one huge namespace?
**A:** Namespaces are the unit of placement; a very large one (a 500k-file company drive) can get its own shard. Journal reads are by `(namespace_id, seq)`, so size doesn't hurt sync speed.

**Q:** Ransomware encrypts a user's files and the client syncs it.
**A:** Version history restores per file or "restore folder to time T" (journal replay to a point). Detect mass-modification bursts and pause sync for that device with an alert.

</details>

## Theory in the notes

- [10-system-design/08-media-and-files.md](../../10-system-design/08-media-and-files.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
