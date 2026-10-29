# arch-49. Debugging: Node service memory grows until OOM-killed

*Debugging · Medium*

## The question

"Our multiplayer lobby service runs Node 22 on EKS: 12 pods, 2 GiB memory limit each, ~8k WebSocket connections per pod. After every restart memory climbs ~300 MB an hour until the pod is OOM-killed, every 5-6 hours, and the players on that pod get disconnected. The last deploy had a dependency bump and a new 'party invites' feature. How do you find and fix the leak?"

**Then:** "Heap snapshots show the JS heap flat at ~400 MB, but the container's RSS still climbs to 2 GiB. What now?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- How exactly does it die? → assume: `kubectl describe pod` shows `OOMKilled` (exit code 137: the kernel killed the container at the cgroup limit). The other failure, V8's "Reached heap limit ... JavaScript heap out of memory" (the process aborts), would point straight at the JS heap.
- Is `--max-old-space-size` set? → assume: no. V8's default limit depends on the Node version and the memory it detects, so set it explicitly.
- Does memory track live connections or time? → assume: connections are flat at ~8k, but players connect and disconnect constantly; memory grows with churn.
- What metrics exist? → assume: Prometheus with prom-client default metrics: `nodejs_heap_size_used_bytes`, `nodejs_external_memory_bytes`, `process_resident_memory_bytes`, GC durations.
- Can we take a pod out of rotation? → assume: yes, by changing its label so the Service stops routing to it.

## Design

**1. Stop the bleeding.** A stopgap only: a scheduled rolling restart every 4 hours with graceful drain (close sockets with a reconnect hint, players land on other pods). Keep the ticket open; restarts hide the leak.

**2. Classify the growth.** Graph per pod: `process.memoryUsage()` fields `rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`. A normal V8 heap is a sawtooth that can sit high; a leak is a **rising floor** after major GCs. `heapUsed` rising → JS objects retained. RSS rising with a flat heap → off-heap (the twist).

**3. Correlate with work.** Memory growth per 1,000 disconnects, per party invite. Compare a canary with the invites flag off. Growth tied to disconnects means per-connection state outlives the connection.

**4. Heap snapshots, safely.** Set `--max-old-space-size=1536` (~75% of the limit, leaving room for buffers, code and native memory) and `--heapsnapshot-signal=SIGUSR2`. Take one pod out of rotation while it still has headroom, then take three snapshots ~20 min apart while a load generator replays connect/disconnect churn. In Chrome DevTools, use the Comparison view, sort by size delta, pick the growing constructor and follow **Retainers** to the GC root: the retainer path names the variable that holds it. A snapshot pauses the process for seconds and can need as much memory again as the heap, which is why it's not taken on a live pod at 90%. For lower overhead over time, the sampling heap profiler (`--heap-prof`) shows which call sites allocate what survives.

**5. Typical finding.**
```ts
// per connection, in the new invites feature
partyBus.on('invite', (inv) => { if (inv.to === player.id) socket.send(...) });
// never removed on close; someone added partyBus.setMaxListeners(0) to silence the warning
```
Each handler's closure keeps the socket, the player object and its buffers alive after disconnect. Fix: one bus listener per process that looks the recipient up in `Map<playerId, socket>`, with `map.delete` in the `close` handler; or at least `partyBus.off` on close.

**6. Other usual suspects to check:** module-level `Map` caches without a bound or TTL; timers per connection never cleared; promises that never settle (no timeout) holding their closures; prom-client labels containing player or lobby IDs (every label combination is kept forever).

**7. Guard.** Alert on the heap floor's slope. A nightly soak test: 6 hours of connect/disconnect churn, asserting heap after a forced GC (`--expose-gc` in tests only) returns near baseline.

## Deep dives

**1. Reading the numbers.** `rss` is everything the OS gave the process; `heapTotal`/`heapUsed` is the V8 JS heap; `external` and `arrayBuffers` are memory outside it owned by JS objects (Buffers, typed arrays); the rest of RSS is code, thread stacks and native allocations. V8 collects lazily, so a high but flat heap is not a leak. If the V8 limit is above the container limit, the kernel SIGKILLs the process first: no JS error, no stack, no chance to write a snapshot. Setting the heap limit below the container limit turns a heap leak into a clear V8 error, and `--heapsnapshot-near-heap-limit` can capture a snapshot right before it.

**2. Why the leak tracks disconnects, not connections.** Live connections are bounded at ~8k, so per-connection state can't grow forever while players are connected. Memory that grows with churn means something registered at connect is not released at close: listeners on a long-lived emitter, entries in a module-level map, intervals. That narrows the search to connect/close code paths before opening a single snapshot.

**3. Off-heap growth (twist).** First check `external` and `arrayBuffers`. If they climb, Buffers are retained: in a WebSocket server the usual cause is sending to clients that stopped reading; `ws` queues the data and `socket.bufferedAmount` grows. Fix: check `bufferedAmount` before sending, drop non-essential updates and close sockets above a cap. If `external` is flat too, the growth is native: check whether the dependency bump enabled `perMessageDeflate` (compression in `ws` uses native zlib, and its own docs warn about memory and performance cost; it's off by default on the server), or native addons. glibc malloc fragmentation across threads shows up exactly as RSS rising with flat JS numbers; compare RSS slope with `MALLOC_ARENA_MAX=2` or jemalloc via `LD_PRELOAD`.

## Traps

- Calling a high but flat heap a leak; V8 collects lazily.
- Raising the memory limit or restarting on a schedule as the fix.
- Taking a heap snapshot on a live pod near its limit: the snapshot itself can push it over and freezes the event loop for seconds.
- `setMaxListeners(0)` to silence the warning that was pointing at the leak.
- Looking only at the heap when RSS grows: Buffers and native memory are outside it.
- Unbounded per-connection send buffers for slow clients.

## Say it (60–90 s)

First I'd add a stopgap, a scheduled rolling restart with graceful drain, and keep the ticket open, because restarts only hide it. Then I classify the growth from process memory metrics: RSS, heap used, and external memory per pod. A heap that sits high but flat is just V8 collecting lazily; a leak is a floor that keeps rising after major GCs. Here connections are flat but players churn, so memory growing with disconnects means something registered on connect is never released on close. I'd set the V8 heap limit to about seventy-five percent of the container limit, take one pod out of the Service while it still has headroom, and take three heap snapshots twenty minutes apart under replayed connect and disconnect traffic. In the comparison view I sort by growth and follow the retainers to see which variable holds the objects. The likely culprit is the new invites feature adding a listener per connection on a shared emitter and never removing it, with the max-listeners warning silenced. The fix is one listener per process and a map of sockets cleaned on close. To keep it fixed, I alert on the heap floor's slope and run a nightly soak test that checks memory returns to baseline after hours of churn.

## Follow-ups

**Q:** Then: the JS heap is flat at 400 MB but RSS climbs to 2 GiB.
**A:** It's off-heap. If `external`/`arrayBuffers` climb, look for Buffers held by slow WebSocket clients (`bufferedAmount`) and cap them. If those are flat too, it's native: check whether the dependency bump turned on `perMessageDeflate` or added a native addon, and test `MALLOC_ARENA_MAX=2` or jemalloc to rule out malloc fragmentation. Native leaks need native tools (heaptrack, jemalloc profiling), not heap snapshots.

**Q:** Why not just restart pods every 4 hours forever?
**A:** Every restart disconnects thousands of players, the leak rate can rise with traffic until 4 hours isn't enough, and the restarts hide the next leak too.

**Q:** How do you stop this from coming back?
**A:** A soak test with connect/disconnect churn in CI nightly, a lint rule or review check for `.on(` on shared emitters without a matching `.off`, the max-listeners warning treated as an error in tests, and an alert on the heap floor's slope in production.

</details>

## Theory in the notes

- [02-nodejs/03-memory-and-performance.md](../../02-nodejs/03-memory-and-performance.md)
- [02-nodejs/01-event-loop-and-runtime.md](../../02-nodejs/01-event-loop-and-runtime.md)
- [02-nodejs/02-streams-and-backpressure.md](../../02-nodejs/02-streams-and-backpressure.md)
- [07-observability-reliability/02-logs-metrics-traces.md](../../07-observability-reliability/02-logs-metrics-traces.md)
