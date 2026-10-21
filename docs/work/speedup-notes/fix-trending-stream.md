# trending-stream.e2e-spec.ts: why 3 tests failed and where the time went

## Why the 3 tests failed
All three are in the group "the aggregate store fails". They put a fault proxy in front of Redis and switch it to "refuse".

1. Cause: the consumer reads an "operator pause" switch from Redis before it takes each batch of messages.
   That read had no time limit. The proxy's "refuse" mode only turns away NEW connections; the connection the app
   already had stayed open and the proxy silently swallowed the request. The answer never came, so the batch
   hung forever, the test waited its 20 s, then the cleanup after the test waited 60 s (hence 75-80 s per failing test).
2. Fix (real code, `infra/trending.consumer.ts`): the pause-switch read now has a short time limit (same 100 ms
   as the other store calls). If the store does not answer, the consumer keeps the last known state and goes on.
   The code already said "pause flag unreadable, keeping the last state"; it just never gave up waiting.
   No check in the tests was weakened.
3. Smaller fix (`testing/trending.fixtures.ts`): the Redis fault proxy had host/port 6400 and database `/0` written
   in. It now takes host, port and database number from REDIS_URL, so it works on a numbered shard.

## Where the 340 s went
- 3 failing tests: about 230 s (75-80 s each, waiting on the hung read and the timed-out cleanup).
- 15 passing tests: about 5.5 s each (about 10 s when the test starts a second consumer, 16 s for the crash test with
  two runs). Almost all of that is the Kafka group join when an app starts: the broker waits a few seconds before
  the first member of a new group gets its partitions. Not real retry waits: backoff base is 5 ms and the call limit is 100 ms.

## What was not done
Sharing one app between tests was not tried: several tests close or restart the consumer, and an earlier attempt
broke 5 tests. The remaining time is the broker's join delay per test, which tests cannot shorten honestly.

## Result (shard 10, whole file)
Before: 3 failed, 15 passed, 352 s. After: 18 passed, 142 s.
