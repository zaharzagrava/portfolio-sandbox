# Shop invitation e-mails: where they go (answer: not a bug)

## Short answer

The invitation mail IS sent. It never goes to Mailpit, because the dev API is started on purpose with a "pretend mailer" that keeps mail inside the API's own memory. You read it from the API, not from Mailpit.

- Mailpit (http://localhost:8025): always 0 messages on this stack. Expected. Do not look there.
- The right place: `GET http://localhost:8000/api/dev/mailbox?to=<invitee e-mail>` (also reachable as `http://localhost:3000/api/dev/mailbox?...`). Returns `{"messages":[{"to","subject","text","links":[...]}]}`. The invitation link is the entry in `links` that contains `/invites/`.

So this is a stack/test-reading problem, not a product bug. No change to scripts/qa/stack-up.sh is needed.

## The full path (checked in code and on the running stack)

1. `POST /api/shops/{shopId}/invites` creates the ShopInvite (only the token hash is stored) and an Outbox row, topic `tenancy-invite-requested`.
2. The outbox relay publishes it to the queue `tenancy-invite-requested` (that is why the Outbox row is "published" and the queue looks empty: it was already taken).
3. `InviteRequestedConsumer` (packages/backend/libs/domains/notifications/infra/invite.consumer.ts) reads that queue. It runs inside the monolith that stack-up.sh starts with `pnpm --filter api run start:dev:monolith`. No extra process is needed. Queue and dead-letter queue are empty because the message was consumed fine.
4. The notification router turns it into type `shop.invite`, and the delivery worker sends it through the e-mail provider.
5. The provider is chosen by `EMAIL_PROVIDER`. The npm script `start:dev:monolith` (packages/backend/package.json line 100) sets `EMAIL_PROVIDER=memory DEV_MAILBOX_ENABLED=true`. The memory provider (infra/providers/memory-email.provider.ts) does not use SMTP at all; it puts the mail in a list in the API process (last 50 mails, newest first).
6. `DevMailboxController` (api/dev-mailbox.controller.ts) shows that list at `/api/dev/mailbox`, only when `DEV_MAILBOX_ENABLED=true` and not production.

The SMTP provider (Mailpit on port 1025, `SMTP_URL` in packages/backend/.env) is only used when `EMAIL_PROVIDER` is NOT `memory`. `PROVIDER_DOUBLES=enabled` is about payments and payouts, not mail.

## Proof on the running stack (this session)

- API log shows `notifications.delivery.sent ... type=shop.invite channel=email provider=memory` for every earlier invite (e.g. 08:31:26, 08:34:32, 08:36:50), so the sending side has always worked.
- Fresh run: registered an owner, created a shop, `POST /invites` with a new address returned 201. Four seconds later `GET /api/dev/mailbox?to=<address>` returned the mail "You are invited to join Inv Probe ..." with link `http://localhost:3000/invites/<token>`. Mailpit still had 0 messages.
- Then registered the invitee, read the token from that link, `POST /api/shop-invites/accept {"token": "..."}` with the invitee's bearer token returned 201 `{"shopId":...,"role":"STAFF"}`.
- (Two throwaway accounts and one shop named "Inv Probe 1792913907" were created on the shared stack by this check.)

## About the `fixme` in the specs

`packages/web/tests/seller-team.spec.ts` (line 25) and `seller-isolation.spec.ts` (line 218) call `test.fixme(!(await devMailboxLists()), ...)`. That probe only asks whether `/api/dev/mailbox` answers 200. Right now it does (verified with curl), so on this stack those tests are NOT skipped by it. The text "the dev mailbox returns nothing" was a wrong guess; the mailbox exists, it was just never checked in the right place (Mailpit). If a tester sees them marked fixme, the API in use was started without `DEV_MAILBOX_ENABLED=true` (then the endpoint answers 404) - for example a hand-started API instead of stack-up.sh. Fix: start it with `pnpm --filter api run start:dev:monolith`.

## Things that can still bite (real but minor)

- The mailbox keeps only the last 50 mails of the whole API, and the `to=` filter is applied AFTER that cut. The stack is shared and every sign-up sends a welcome mail (44 of the current 50 are welcome mails). If many tests register users between "send invitation" and "read the link", the invite mail can be pushed out. Read the link right after sending, and poll (the helper `readInviteLink` polls up to 15 s).
- The list lives in API memory: restarting the API empties it.
- Delivery takes about 1-2 s after the 201 (queue + worker); poll, do not read once.
- Matching is exact on the e-mail address (case-insensitive). Use a unique address per test.

## How testers can check the accept flow without any mail reader

Option A (closest to a user): get the link from the dev mailbox as above, open `http://localhost:3000/invites/<token>` in the invitee's signed-in browser, press "Accept invitation". Expected: lands on `/dashboard/seller/{shopId}`, banner "You joined as Staff." (spec W04 AS-80; going back must not return to the invite page, AS-82). Playwright helper: `readInviteLink(email)` in packages/web/tests/helpers.ts.

Option B (API only): owner `POST /api/shops/{shopId}/invites {"email","role"}` -> read token from `/api/dev/mailbox?to=<email>` (last path part of the `/invites/` link) -> invitee signed in `POST /api/shop-invites/accept {"token"}` -> 201 `{shopId, role}` (200 `alreadyMember` if repeated). A wrong, used or revoked token gives 404 `invite_not_found`.

There is no token in the API logs (by design the token is never logged, FR-014) and the database keeps only its hash, so the dev mailbox is the only source. Do not try to read it from Mailpit, the Outbox row, or the queue.
