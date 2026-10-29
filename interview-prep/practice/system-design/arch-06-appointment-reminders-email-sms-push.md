# arch-06. Appointment reminders: email, SMS, push

*Messaging · Medium*

## The question

"We're a scheduling platform for ~2,000 US clinics. We send booking confirmations, reminders 48 hours and 2 hours before appointments, 'the doctor is running late' alerts and cancellation notices to ~1.5M patients by email, SMS and push. About 400k messages a day, with a spike every morning when clinics bulk-reschedule. SMS costs money, nobody should get a reminder at 3 a.m., and a patient must never get two copies of the same SMS. Design the notification service."

**Then:** "A clinic reschedules an appointment 10 minutes before its 2-hour reminder goes out, while the SMS provider is timing out on 30% of requests. What does the patient receive?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Health data in messages? → assume: yes, it's PHI. HIPAA permits appointment reminders, but SMS and push show on lock screens, so bodies carry the minimum: clinic name, date and time, a link. No reason for visit, no provider specialty. Every provider handling message content must sign a BAA. Confirm details with compliance.
- Channels per message type? → assume: patient chooses per category; booking and cancellation notices can't be fully turned off (at least one channel).
- Two-way SMS? → assume: yes, "Reply C to confirm, R to reschedule", plus STOP/HELP keywords, which US carriers require us to honor.
- Quiet hours? → assume: 21:00-08:00 in the patient's time zone, falling back to the clinic's IANA zone. "Running late" alerts for today bypass them (they're within clinic hours anyway).
- Latency? → assume: "running late" and cancellations within 1 minute; reminders within ~15 minutes of their slot.
- Numbers → assume: 400k/day ≈ 5/s avg; morning spike ~200/s for 30 minutes; ~50% SMS. Message rows ~1 KB → 400 MB/day. Retention is a compliance decision (HIPAA's documentation rule is 6 years; medical-record retention is set by state law); assume 6 years, older partitions archived to S3.

## Design

**Flow**
1. The scheduling service writes domain events through its outbox → SNS → SQS `notification-events`: `AppointmentBooked`, `AppointmentRescheduled`, `AppointmentCancelled`, `ProviderRunningLate`, each with `event_id` and the appointment's `version`.
2. **Planner** consumes events. For reminders it inserts rows with `send_after = starts_at − 48h` and `− 2h`, adjusted out of quiet hours, and `expires_at = starts_at`. For each recipient and allowed channel: `dedupe_key = event_id:template:channel:patient_id`, `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`.
3. On `AppointmentRescheduled`/`Cancelled`, the planner sets planned reminders for the old version to `superseded` and plans new ones.
4. **Senders**, one pool per channel and priority, claim due rows with `FOR UPDATE SKIP LOCKED`, then **re-check the appointment** (`status`, `version`, `starts_at`) before rendering. Version changed → `superseded`, no send.
5. Render the pinned template version (English/Spanish by patient locale), call the provider through a per-provider rate limiter and circuit breaker, store `provider_msg_id`.
6. **Provider webhooks** update delivery status; hard bounces, complaints and STOP replies go to `suppressions`. FCM `UNREGISTERED` / APNs `410` remove the device token. Inbound "C"/"R" replies become `AppointmentConfirmed` / reschedule-link events.

```sql
notifications(
  id uuid PRIMARY KEY, dedupe_key text UNIQUE, patient_id uuid, appointment_id uuid,
  appointment_version int, channel text, template_id text, template_version int,
  priority text,          -- critical | normal | bulk
  status text,            -- planned | sending | sent | delivered | failed | unknown | superseded | expired | suppressed
  send_after timestamptz, expires_at timestamptz,
  provider text, provider_msg_id text, attempts int DEFAULT 0, last_error text)
CREATE INDEX ON notifications (channel, priority, send_after) WHERE status = 'planned';
preferences(patient_id, category, channel, enabled, PRIMARY KEY (patient_id, category, channel))
suppressions(channel, address_hash, reason, created_at, PRIMARY KEY (channel, address_hash))
```
Rendered bodies of cancellation notices go to S3 (encrypted, access-logged): "we told the patient" may need proof.

## Deep dives

**1. The reschedule race (twist, part 1).** The planner may not have processed `AppointmentRescheduled` when the sender claims the old reminder. Chosen: the sender re-reads the appointment and compares `version` right before sending; a mismatch makes the row `superseded`. The new reminder (planned from the new version) goes out at its own time, and a "your appointment moved" message is sent immediately as critical. Remaining window: the check and the provider call are milliseconds apart; accepted. Rejected: relying only on the planner deleting old rows (event lag makes that a race).

**2. Ambiguous sends (twist, part 2).** A unique `dedupe_key` stops duplicate events, not duplicate sends: on a timeout we don't know if the SMS went out, and most SMS APIs have no idempotency key. Chosen: timeout → status `unknown`; look it up by our reference in the provider's message API before any retry; if still unknown after a few minutes, don't re-send the SMS, fall back to push/email for critical messages. Only clear failures (connection refused, 5xx/429 before acceptance) retry or go to the secondary provider. Rejected: "retry until 2xx", which is how patients get two texts.

**3. Provider failover.** Circuit breaker per provider on error rate and latency. US A2P SMS needs 10DLC campaign registration (or a verified toll-free number) per sending number, so a secondary provider that was never used often fails when needed. Chosen: route ~5% of traffic through the secondary every day. Rejected: a cold standby.

**4. Morning spike vs urgent messages.** 50k bulk reschedule notices must not delay "doctor running late, 40 minutes". Separate lanes per priority, critical claimed first, bulk spread by `send_after` jitter. SMS throughput per number is limited by carrier rules and registration tier, so plan the number pool for the peak.

## Traps

- The scheduling service calling the SMS API inside its own transaction: a rollback after the send means a message about an appointment that was never booked.
- Sending a reminder planned yesterday without re-checking the appointment's current version.
- PHI in SMS or push bodies ("your oncology follow-up"): it's shown on the lock screen.
- Failing over to the secondary provider on a timeout: the first one may already have delivered.
- Quiet hours in server UTC.
- Ignoring STOP replies or letting suppressions live only in the provider's dashboard: carriers and regulators expect STOP to be honored, and a provider switch would lose them.

## Say it (60–90 s)

Notifications are their own service, driven by events. The scheduling service publishes booked, rescheduled, cancelled and running-late events through its outbox, each with the appointment's version. A planner turns them into notification rows per patient and channel, with a unique dedupe key built from event ID, template, channel and patient, so redelivered events can't plan twice. Reminders get a send-after time outside quiet hours in the patient's time zone and expire at the appointment start. Senders per channel and priority claim due rows with SKIP LOCKED, and right before sending they re-read the appointment and compare versions; if it was rescheduled, the old reminder is marked superseded and never sent. That's the first half of the twist. Message bodies are minimal because lock screens show them: clinic, time and a link, no medical details. Provider webhooks update status, and bounces and STOP replies go to a suppression list we own. For the timeouts: a timed-out SMS becomes unknown, I check the provider by our reference, and I never re-send an SMS blindly; critical messages fall back to push or email. I fail over to the second provider only on clear failures and keep a little traffic on it daily so it's known to work.

## Follow-ups

**Q:** How do you handle a patient whose phone number changed and now belongs to someone else?
**A:** Carrier deactivation data and delivery failures flag numbers; on a flag we stop SMS until the patient re-verifies the number by a code. Minimal message content limits the damage.

**Q:** How do you test templates?
**A:** Snapshot tests per template, locale and fixture; a length check per SMS (GSM-7 allows 160 chars per single segment, any non-GSM character switches to UCS-2 with 70, which doubles cost); preview in the admin.

**Q:** What does "delivered" prove?
**A:** For SMS, a carrier delivery receipt (not always available, varies by carrier and country); for email, that the receiving server accepted it. Neither proves the patient read it.

</details>

## Theory in the notes

- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
