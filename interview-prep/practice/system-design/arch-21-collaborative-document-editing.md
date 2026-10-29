# arch-21. Collaborative document editing

*Realtime · Hard*

## The question

"Design real-time collaborative editing for our B2B docs product: several people edit the same rich-text document and see each other's changes and cursors live; editing must keep working offline and sync later. ~1M daily users, ~30k documents open at any moment, usually 1-5 editors per document."

**Then:** "One user edits a document offline for three days on a plane and reconnects. Separately, during a company all-hands, 200 people open and type into the same document."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Content? → assume: rich text (paragraphs, headings, lists, tables), images as references to S3. No spreadsheets.
- Consistency expectation? → assume: everyone converges to the same document; intent preservation is best effort for concurrent edits to the same words.
- Permissions? → assume: owner/editor/commenter/viewer per document, changeable at any time.
- Version history? → assume: yes, named versions and automatic snapshots.
- Numbers → assume: 30k open docs, ~60k connections. ~20% of editors typing at any moment, clients batch edits every ~100-200 ms → tens of thousands of small updates/s cluster-wide, each ~50-200 B. Cursor/presence messages are usually more numerous than edits.
- Document size → assume: median 50 KB of encoded state, largest ~10 MB.

## Design

**1. Data model: a CRDT (Yjs).** Each client holds a Yjs document bound to the editor (ProseMirror/TipTap binding). Every insert has a unique ID (client ID + clock), so updates merge in any order and applying the same update twice changes nothing.

**2. Rooms.** One collaboration server process owns each open document ("room"), chosen by consistent hashing on `doc_id` (routing table in Redis, or the load balancer hashing on the doc ID in the WebSocket URL). The room holds the authoritative in-memory Y.Doc.

**3. Sync.**
1. Connect: auth check (JWT → role for this doc). Client sends its state vector; server replies with the updates the client lacks; client sends what the server lacks.
2. Live: client sends updates; server applies, broadcasts to the room, persists.
3. Awareness (cursors, selections, names) is a separate ephemeral channel, broadcast only, throttled, never stored.

**4. Persistence.**
```sql
doc_updates(doc_id, seq bigserial, update bytea, client_id, created_at)   -- append-only
doc_snapshots(doc_id, upto_seq bigint, state bytea, created_at)           -- compacted
```
The room batches incoming updates every ~200 ms into one insert and acks clients after commit. Clients keep their own updates in IndexedDB until acked, so a server crash loses nothing: they resend on reconnect, and re-applying is harmless. Every ~500 updates or 5 minutes, the room encodes the full state into a snapshot and deletes older updates. Loading a room = latest snapshot + updates after it.

**5. Permissions.** Viewer/commenter connections are read-only: the server drops their document updates. A permission change publishes an event; rooms disconnect or downgrade affected connections.

**6. History.** Snapshots kept as versions (hourly while active, plus named versions). Yjs garbage-collects deleted content by default, so history comes from snapshots, not from the live doc.

**7. Search/export.** On snapshot, render plain text/HTML for the search index and previews.

## Deep dives

**1. OT vs CRDT.** OT (what Google Docs uses) sends operations to a central server that orders them and transforms concurrent ones against each other. It works, but transform functions for rich text are hard to get right, and long offline sessions mean transforming against thousands of operations. CRDTs give every character an identity so merges commute; offline is natural. Costs: metadata per item (Yjs compresses runs of typing well) and occasional odd merges (two people typing at the same spot interleave). Chosen: Yjs with a central server for auth, persistence and fan-out. Rejected: OT (we'd be writing a transform engine); peer-to-peer CRDT (no place to enforce permissions or persist).

**2. Three days offline (twist, part 1).** The client has the doc in IndexedDB plus its unacked updates. On reconnect, state vectors are exchanged and both sides receive what they're missing; the result converges, nothing is lost. Semantic conflicts are possible (both rewrote the same paragraph → both texts appear, possibly mixed). Chosen: take an automatic snapshot before merging large offline changes, show "N offline changes merged" with a diff against that snapshot, and let the user restore. If their permission was revoked meanwhile, the server rejects the updates and the client offers "save as a copy". Rejected: blocking edits offline or last-writer-wins on paragraphs.

**3. 200 editors in one doc (twist, part 2).** Naive fan-out: 200 typists × 5 updates/s × 199 recipients ≈ 200k messages/s from one Node process, plus cursor traffic. Chosen: the room merges updates per broadcast tick (`Y.mergeUpdates` every 50-100 ms, one message per client per tick), awareness throttled to ~2-5/s per user and only for users in view, and fan-out offloaded: the owner publishes merged updates to a Redis channel, and several edge servers holding the sockets forward them. Above a cap (e.g. 100 active editors) new joiners become viewers with a "request edit" button. Rejected: scaling up the single process.

**4. Owner failover and split brain.** If two servers both think they own a room (routing change mid-flight), both apply and persist updates. With a CRDT that's only inefficient: all updates merge into the same state. With OT, two orderings would corrupt the document. That's a strong practical argument for CRDTs.

## Traps

- Sending the whole document on every change, or last-writer-wins on the document.
- Persisting cursor/presence updates: most of the traffic, none of the value.
- Acking edits before they're durable, with clients discarding them: a server crash loses work.
- Keeping updates forever without snapshots: loading a year-old doc replays millions of updates.
- Relying on the CRDT for history: deleted content is garbage-collected; history needs snapshots.
- Enforcing permissions only in the UI: a viewer's client can still send updates; the server must drop them.

## Say it (60–90 s)

I'd use a CRDT, Yjs, rather than OT. Every inserted character has a unique ID, so updates merge in any order and applying one twice is harmless, which makes offline editing and retries simple. Each open document has one owning room on a collaboration server, chosen by hashing the document ID. On connect, the server checks the user's role and exchanges state vectors with the client so each side sends only what the other is missing; after that, updates are applied, broadcast to the room and appended to an updates table in batches every couple hundred milliseconds. Clients keep their updates locally until the server acks the commit, so a crash loses nothing. Every few hundred updates the room writes a compacted snapshot, and loading is snapshot plus newer updates. Cursors go over a separate ephemeral channel and are never stored. Viewers' updates are dropped on the server. For the three days offline, state vectors merge everything; I snapshot before merging and show a diff so the user can review. For two hundred editors, I merge updates per broadcast tick, throttle cursors, and spread socket fan-out across edge servers through Redis.

## Follow-ups

**Q:** How do comments stay attached to text that moves?
**A:** Anchor them with Yjs relative positions (item IDs), not character offsets; they follow the text through concurrent edits. Comments themselves live in a normal Postgres table.

**Q:** How big does the CRDT metadata get?
**A:** For typical documents, the encoded state is a small multiple of the text size because consecutive typing compresses into runs; pathological edit patterns grow it. Snapshots are compacted, and very large docs are monitored by encoded size.

**Q:** Can the server see and search the content?
**A:** Yes in this design; it renders snapshots to text for search. End-to-end encryption would require clients to encrypt updates and would remove server-side search and previews.

</details>

## Theory in the notes

- [10-system-design/06-realtime-and-collaboration.md](../../10-system-design/06-realtime-and-collaboration.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [02-nodejs/01-event-loop-and-runtime.md](../../02-nodejs/01-event-loop-and-runtime.md)
