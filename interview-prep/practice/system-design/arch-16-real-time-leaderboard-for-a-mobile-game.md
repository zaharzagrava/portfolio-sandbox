# arch-16. Real-time leaderboard for a mobile game

*Gaming · Easy*

## The question

"Our mobile game has 20M players, 5M daily active. After every match the score is submitted, and players want to see the global top 100, their own rank, and the players just above and below them, updated in real time. There's a weekly leaderboard that resets every Monday plus an all-time one. Design it."

**Then:** "The weekly reset at Monday 00:00 UTC lands while players in 30 time zones are mid-match. And support says two players with the same score swap places when they refresh."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Score rule? → assume: best score per player per board (not sum); higher is better.
- Anti-cheat? → assume: scores come from our game server, not the client; the client only displays.
- Friends leaderboard? → assume: yes, ranks among a player's friends (≤ 500 friends).
- Regional boards? → assume: later; design must allow it.
- Numbers → assume: 5M DAU × ~20 matches = 100M score submissions/day ≈ 1.2k/s avg, ~10k/s peak. Reads: rank/around-me on every match end + top-100 views ≈ similar order. Memory: Redis sorted set ~60-100 B per member → 20M members ≈ 1.5-2 GB per board, fits one Redis node.
- Durability → assume: Postgres keeps every player's best score per season; Redis is rebuilt from it.

## Design

**1. Submit** (from the game server after a match):
- Postgres: `UPSERT best_scores(season_id, player_id, score, achieved_at) … DO UPDATE SET score = EXCLUDED.score, achieved_at = EXCLUDED.achieved_at WHERE best_scores.score < EXCLUDED.score`.
- Redis: `ZADD lb:weekly:2026-W44 GT <encoded> <playerId>` and the same for `lb:alltime`. `GT` (Redis 6.2+) only updates when the new score is higher, so a late or duplicate submission can't lower it.

**2. Encoded score (tie-break).** A sorted set orders equal scores by member string, which is arbitrary and makes ties look random. Encode `score × 2^23 + (2^23 − 1 − seconds_since_season_start)`: higher score first, then earlier achievement first. Doubles are exact up to 2^53, so score must stay below 2^30 (~1 billion), and 2^23 s ≈ 97 days covers a weekly season (all-time uses a coarser time unit or a fixed rank on ties).

**3. Reads**
- Top 100: `ZRANGE lb:weekly:2026-W44 0 99 REV WITHSCORES` → hydrate names/avatars from a profile cache. Cache the result for 2-5 s; it's the most requested and identical for everyone.
- My rank: `ZREVRANK key playerId` (O(log N)), 1-based for display.
- Around me: `ZRANGE key rank-5 rank+5 REV`.
- Friends: `ZMSCORE key f1 f2 … f500`, sort in the app.

**4. Seasons.** Keys include the season: `lb:weekly:2026-W44`. At the boundary, submissions go to the new key; the old one stays read-only for "last week's results", then `EXPIRE` after 14 days. No bulk delete.

**5. Rewards.** A job after the reset reads the final top N from the closed key and grants rewards idempotently (`UNIQUE (season_id, player_id)` on rewards).

**6. Recovery.** If Redis is lost, rebuild from `best_scores` in batches of 10k `ZADD`s; ~20M rows takes minutes. Redis with AOF + a replica makes this rare.

## Deep dives

**1. Reset with matches in progress (twist, part 1).** Which week does a match that started Sunday 23:58 and ended Monday 00:03 count for? Chosen: the season is decided by the match **start** time, stamped by the game server, so the submission goes to `lb:weekly:2026-W44` even after midnight; the closed key accepts writes for a 30-minute grace period, then rewards are computed. The weekly reset is one global UTC instant; showing "resets in 3h 12m" in local time makes that clear to players. Rejected: deleting the key at midnight (in-flight scores land in the new week or vanish), per-time-zone resets (one global ranking can't have 30 boundaries).

**2. Ties swapping (twist, part 2).** Equal scores are ordered by member lexicographically, so they shouldn't swap randomly; they swap when the score is stored as a float with sub-integer noise, or when two replicas/keys are read alternately, or when the client sorts again. Chosen: deterministic tie-break encoded into the score (earlier achievement wins), all reads from the primary for the rank/around-me calls, and rank shown as "tied #57" when raw scores are equal if the product prefers. Rejected: secondary sort in the app after fetching (different pages disagree).

**3. Sharding when one node isn't enough.** 20M members fit one node; at hundreds of millions, or for write throughput, split by score range or by player hash. Rank with hash sharding = Σ over shards of `ZCOUNT key (myScore +inf` (scatter-gather, still O(log N) per shard). Chosen: one node + replica now; trigger is memory > ~25 GB or CPU > 50%.

## Traps

- `SELECT … ORDER BY score DESC` with `OFFSET` for rank in Postgres: rank of a player in 20M rows means counting everything above them on every request.
- Plain `ZADD` without `GT`: a duplicate or delayed lower score overwrites the best.
- Trusting scores sent by the client.
- Encoding tie-breaks without checking double precision: above 2^53 the low bits silently disappear.
- Deleting or renaming the weekly key at midnight instead of versioned keys per season.

## Say it (60–90 s)

Redis sorted sets are made for this: twenty million players at under a hundred bytes each is under two gigabytes per board. After a match, the game server, not the client, submits the score. I upsert the best score per player and season into Postgres, which is the durable record, and do a ZADD with the GT flag into the sorted set, so a duplicate or late lower score can't overwrite the best. Top one hundred is a reverse ZRANGE cached for a couple of seconds; a player's rank is ZREVRANK, which is logarithmic; around-me is a range of five above and below; friends are a ZMSCORE on their list. To make ties deterministic, I encode the score with the time it was achieved, so the earlier player wins and nobody swaps on refresh, keeping the total under the fifty-three bits a double holds exactly. Each week is its own key, like week forty-four; at the reset new scores go to the new key and the old one stays read-only for results and expires later. A match counts for the week it started in, with a short grace period before rewards are computed. If Redis is lost, I rebuild it from Postgres in minutes.

## Follow-ups

**Q:** How do you show "top 1%" instead of an exact rank for most players?
**A:** `ZCARD` once per minute (cached) and `ZREVRANK` per player: percentile = rank / card. Cheap and stable.

**Q:** Regional leaderboards?
**A:** One more key per region per season, written in the same pipeline; at 10k submissions/s, a few ZADDs per submission is fine.

**Q:** A cheater is banned. How do you remove them?
**A:** `ZREM` from every current key, flag in Postgres so rebuilds skip them, and recompute rewards for closed seasons if they were in the top N.

</details>

## Theory in the notes

- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [10-system-design/02-worked-examples.md](../../10-system-design/02-worked-examples.md)
- [10-system-design/01-system-design-framework.md](../../10-system-design/01-system-design-framework.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
