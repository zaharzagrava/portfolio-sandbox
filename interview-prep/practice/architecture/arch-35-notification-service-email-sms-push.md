# arch-35. Notification service: email, SMS, push

*Messaging · Medium*

## The question

"We send rent reminders, payment receipts and 'payment failed' alerts to ~300k tenants and ~20k landlords by email, SMS and push. Normal volume is ~50k messages a day; on the 1st it's ~400k. Tenants choose channels per message type, SMS costs real money, nobody should get a reminder at 3 a.m., and a tenant must never get the same 'payment failed' SMS twice. Design the notification service."

**Then:** "On rent day your SMS provider starts timing out on 30% of requests. What happens in your design?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Transactional only, or marketing too? → assume: transactional only (receipts, reminders, failures, security). Marketing has separate consent rules that vary by country (e.g. US TCPA, Israel's anti-spam law), so it's out of scope.
- Who decides that a notification is needed? → assume: domain services publish facts (`PaymentFailed`); the notification service owns rules, channels and templates. Payments never knows SMS exists.
- Latency? → assume: 'payment failed' within 1 minute; reminders within an hour of their slot.
- Languages? → assume: Hebrew and English per recipient locale; Hebrew is RTL in email and changes SMS encoding (UCS-2, so fewer characters per segment and higher cost).
- Quiet hours in whose time zone? → assume: recipient's, falling back to the property's IANA zone; 21:00-08:00; security messages (OTP, new login) bypass.
- Providers? → assume: SES for email, one primary + one secondary SMS provider, FCM for Android and APNs for iOS.

## Design

**Flow**
1. Domain services write events to their outbox → SNS → SQS `notification-events`. Each event has a stable `event_id`.
2. **Planner** (consumer): event type → rules → for each recipient and allowed channel, build `dedupe_key = event_id:template:channel:recipient_id` and `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING`. A conflict means the event was already planned, so redelivery is harmless.
3. Planner sets `send_after` (quiet hours → next 08:00 local, plus a few minutes of jitter) and `expires_at` (a "rent due today" reminder is useless tomorrow).
4. **Senders**, one pool per channel and priority, claim due rows with `FOR UPDATE SKIP LOCKED`, render the pinned template version, call the provider, store `provider_msg_id`. Each provider has its own rate limiter and circuit breaker.
5. **Status webhooks** from providers update `delivered / bounced / complained / undelivered`. Hard bounce or complaint → suppression list. FCM `UNREGISTERED` or APNs `410` → delete the device token.
6. **Fallback per template**: 'payment failed' tries push, then SMS if push isn't possible (no token) or fails; receipts always go by email because they're a record.

```sql
notifications(
  id uuid PRIMARY KEY, dedupe_key text UNIQUE, recipient_id uuid, channel text,
  template_id text, template_version int, locale text, payload jsonb,
  priority text,          -- critical | normal | bulk
  status text,            -- planned | sending | sent | delivered | failed | suppressed | expired | unknown
  send_after timestamptz, expires_at timestamptz,
  provider text, provider_msg_id text, attempts int DEFAULT 0, last_error text)
CREATE INDEX ON notifications (channel, priority, send_after) WHERE status = 'planned';

preferences(recipient_id, category, channel, enabled, PRIMARY KEY (recipient_id, category, channel))
suppressions(channel, address_hash, reason, created_at, PRIMARY KEY (channel, address_hash))
```
Categories `security` and `receipts` can't be switched off by email; `reminders` can. Rendered bodies of receipts and late-fee notices go to S3, because "we told the tenant on the 3rd" may need proof later.

## Deep dives

**1. Ambiguous sends: the duplicate-SMS problem.** The unique `dedupe_key` stops duplicate *events*. It can't stop duplicate *sends*: the provider call times out and we don't know if the SMS went out. Most SMS APIs have no idempotency key. Chosen: on a timeout the row goes to `unknown`, and we look it up by our reference in the provider's message API before any retry. For critical SMS we accept at-most-once: if status stays unknown, fall back to push/email, never re-send the SMS. Rejected: "retry until 2xx", which is how tenants get two 'payment failed' texts.

**2. Provider failover.** A circuit breaker per provider opens on error rate or latency. Only *clearly failed* calls (connection refused, 5xx or 429 before acceptance) move to the secondary; timeouts are ambiguous (point 1). Sender registration differs by country and number type (e.g. US 10DLC registration, alphanumeric sender IDs elsewhere), so an untested secondary often fails on the day you need it. Chosen: route ~5% of traffic to the secondary all the time so it stays proven. Rejected: a cold standby that nobody has sent through in months.

**3. Rent-day volume vs urgent messages.** 300k reminders must not delay a 'payment failed'. Separate lanes per priority (separate claim queries or SQS queues), critical lane served first. Reminders are planned the night before with `send_after` spread over 08:00-10:00 local. SES has per-account send-rate and daily quotas (raised on request, check yours before the 1st); SMS throughput is limited per sender and varies by country. Rejected: one FIFO queue for everything.

## Traps

- Payments calling SES/SMS directly inside its flow: payment latency now depends on an email provider, and a rollback after the send means a message about a payment that never happened. Go through the outbox.
- Dedupe in Redis with `SET NX` + TTL: not atomic with the notification record, the key expires, and there's no audit trail. A unique constraint in the table is both.
- Failing over to the secondary on a *timeout*: the first provider may already have sent it. Duplicate SMS.
- Quiet hours computed in server UTC: Israel and US tenants get messages at night.
- Ignoring bounces and complaints: SES can put the account under review or pause sending when bounce/complaint rates get high, and that stops receipts for everyone.
- Letting users opt out of everything, including security and legally required notices.

## Say it (60–90 s)

I treat notifications as their own service that reacts to domain events. Payments just publishes PaymentFailed through its outbox; it doesn't know about SMS. A planner consumes the event, applies rules and the recipient's preferences, and inserts one row per recipient and channel with a dedupe key made of event ID, template, channel and recipient. That key has a unique constraint, so a redelivered event can't plan a second message. The planner also sets send-after for quiet hours in the recipient's time zone and an expiry, because a reminder for today is useless tomorrow. Sender workers per channel and priority claim due rows with SKIP LOCKED, render a pinned template version, and call the provider through a rate limiter and a circuit breaker. Critical messages have their own lane, so 300,000 rent reminders can't delay a payment-failed alert. Provider webhooks update delivery status, bounces and complaints go to a suppression list, and dead push tokens are removed. The hard part is a timeout: the SMS may have gone out. I mark it unknown, check the provider by our reference, and for critical SMS I fall back to push or email instead of re-sending. I only fail over to the second provider on clear failures, and I keep a few percent of traffic on it so I know it works.

## Follow-ups

**Q:** How do you test templates in two languages?
**A:** Snapshot tests per template, locale and fixture payload; a preview page in the admin; RTL rendering checks for Hebrew email; the template version is stored on each notification so a bad version can be traced and rolled back.

**Q:** How do you prove a tenant was told about a late fee?
**A:** The notification row, the rendered body in S3, the provider message ID and the delivery webhook. Be precise about what "delivered" means: for email it means the receiving server accepted it, not that the tenant read it.

**Q:** What about in-app notifications?
**A:** Another channel that writes to an `inbox` table and pushes over the app's existing real-time connection (arch-22). Same planner, same dedupe key.

</details>

## Theory in the notes

- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
