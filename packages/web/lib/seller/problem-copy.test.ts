import { describe, expect, it } from 'vitest';
import type { Problem } from '@/lib/api/errors';
import { problemDetailOf, sellerProblemCopy, type SellerProblemContext } from './problem-copy';

const problem = (status: number, code?: string, extra: Partial<Problem> = {}): Problem => ({ status, ...(code ? { code } : {}), errors: [], ...extra });

type Row = [name: string, problem: Problem, context: SellerProblemContext, expected: Record<string, unknown>];

const SERVER = 'Something went wrong on our side.';

/** One row per code of the spec's "Error catalogue" (and the status-only rows). */
const rows: Row[] = [
  ['validation_failed with a field', problem(400, 'validation_failed', { errors: [{ field: 'title', code: 'too_short' }] }), {}, { form: 'field', field: 'title', message: 'Check this field.' }],
  ['validation_failed without fields', problem(400, 'validation_failed'), {}, { form: 'alert', message: 'Check the details and try again.' }],
  ['shop_mismatch', problem(400, 'shop_mismatch', { requestId: 'r1' }), {}, { form: 'alert', message: SERVER, reference: 'r1' }],
  ['invalid_topics', problem(400, 'invalid_topics', { requestId: 'r1' }), {}, { form: 'alert', message: SERVER, reference: 'r1' }],
  ['invalid_query', problem(400, 'invalid_query'), {}, { form: 'alert', message: SERVER }],
  ['invalid_cursor', problem(400, 'invalid_cursor'), { kind: 'read' }, { form: 'page', message: 'That page link is no longer valid.', action: 'first-page' }],
  ['unauthenticated', problem(401, 'unauthenticated'), {}, { form: 'session', message: 'Your session ended. Sign in again to continue.' }],
  ['invalid_token', problem(401, 'invalid_token'), {}, { form: 'session' }],
  ['session_expired', problem(401, 'session_expired'), {}, { form: 'session' }],
  ['401 without a code', problem(401), {}, { form: 'session' }],
  ['permission_denied on a page', problem(403, 'permission_denied'), { kind: 'read', place: 'page' }, { form: 'page', message: "You don't have access to this page." }],
  ['permission_denied on an action', problem(403, 'permission_denied'), {}, { form: 'toast', message: "You don't have permission to do that." }],
  ['insufficient_role', problem(403, 'insufficient_role'), {}, { form: 'alert', message: "You can't change this member's role." }],
  ['mfa_required', problem(403, 'mfa_required'), {}, { form: 'alert', message: 'Live keys need two-step verification.', action: 'two-step' }],
  ['shop_suspended', problem(403, 'shop_suspended'), {}, { form: 'alert', message: 'This shop is suspended. You can view data but not make changes.', refetch: true }],
  ['shop_offboarding', problem(409, 'shop_offboarding'), {}, { form: 'alert', message: 'This shop is being closed. You can view data but not make changes.', refetch: true }],
  ['stream forbidden', problem(403, 'forbidden'), { place: 'stream' }, { form: 'alert', message: "Live numbers aren't available right now. Showing today's totals." }],
  ['shop_not_found on a page', problem(404, 'shop_not_found'), { kind: 'read', place: 'page' }, { form: 'page', message: "We couldn't find that shop." }],
  ['shop_not_found in a dialog', problem(404, 'shop_not_found'), { place: 'dialog' }, { form: 'alert', message: 'This shop is no longer available.' }],
  ['product_not_found', problem(404, 'product_not_found'), {}, { form: 'alert', message: 'This product no longer exists.', refetch: true }],
  ['member_not_found', problem(404, 'member_not_found'), {}, { form: 'toast', message: 'This member is no longer in the team.', refetch: true }],
  ['webhook_endpoint_not_found', problem(404, 'webhook_endpoint_not_found'), {}, { form: 'toast', message: 'This endpoint was already deleted.', refetch: true }],
  ['webhook_event_not_found', problem(404, 'webhook_event_not_found'), {}, { form: 'alert', message: 'This event is older than 30 days or no longer available.' }],
  ['resource_missing', problem(404, 'resource_missing'), {}, { form: 'toast', message: 'This key no longer exists.', refetch: true }],
  ['invite_not_found', problem(404, 'invite_not_found'), {}, { form: 'page', message: "This invitation isn't valid for this account. It may have expired, been used, or been sent to a different e-mail address." }],
  ['not_ranked', problem(404, 'not_ranked'), {}, { form: 'page', message: 'Not ranked yet. Your shop appears on the leaderboard after its first paid order.' }],
  ['version_conflict', problem(409, 'version_conflict'), {}, { form: 'alert', message: 'This product changed since you opened it.', action: 'load-latest' }],
  ['product_archived', problem(409, 'product_archived'), {}, { form: 'alert', message: 'This product was archived or restored elsewhere. The list has been refreshed.', refetch: true }],
  ['invalid_transition', problem(409, 'invalid_transition'), {}, { form: 'alert', message: 'This product was archived or restored elsewhere. The list has been refreshed.', refetch: true }],
  ['key_revoked', problem(409, 'key_revoked'), {}, { form: 'alert', message: 'This key is already revoked.', refetch: true }],
  ['key_expired', problem(409, 'key_expired'), {}, { form: 'alert', message: 'This key has expired.', refetch: true }],
  ['key_already_rotating', problem(409, 'key_already_rotating'), {}, { form: 'alert', message: 'This key is already being rotated.', refetch: true }],
  ['endpoint_state_conflict', problem(409, 'endpoint_state_conflict'), {}, { form: 'toast', message: 'The endpoint was changed elsewhere. The list has been refreshed.', refetch: true }],
  ['rotation_in_progress', problem(409, 'rotation_in_progress'), {}, { form: 'alert', message: 'A previous secret is still valid. End it first or wait.', action: 'end-old-secret' }],
  ['no_previous_secret', problem(409, 'no_previous_secret'), {}, { form: 'toast', message: '', refetch: true, silent: true }],
  ['endpoint_disabled', problem(409, 'endpoint_disabled'), {}, { form: 'alert', message: 'Enable the endpoint first.' }],
  ['idempotency_in_flight', problem(409, 'idempotency_in_flight'), {}, { form: 'alert', message: 'This replay is already being processed.' }],
  ['duplicate_endpoint_url', problem(409, 'duplicate_endpoint_url'), {}, { form: 'field', field: 'url', message: 'You already have an endpoint with this URL.' }],
  ['slug_taken', problem(409, 'slug_taken'), {}, { form: 'field', field: 'slug', message: 'That handle is taken. Try another.' }],
  ['slug_reserved', problem(422, 'slug_reserved'), {}, { form: 'field', field: 'slug', message: 'That handle is reserved. Try another.' }],
  ['shop_limit_reached', problem(409, 'shop_limit_reached'), {}, { form: 'alert', message: 'You already own 10 shops.' }],
  ['seat_limit_reached', problem(409, 'seat_limit_reached'), {}, { form: 'alert', message: 'Your plan has no free seats.' }],
  ['invite_pending', problem(409, 'invite_pending'), {}, { form: 'alert', message: 'An invitation is already pending for this address.' }],
  ['already_member', problem(409, 'already_member'), {}, { form: 'alert', message: 'This person is already a member.' }],
  ['last_owner', problem(409, 'last_owner'), {}, { form: 'alert', message: 'A shop needs at least one owner.' }],
  ['stale_version', problem(409, 'stale_version'), {}, { form: 'toast', message: 'This changed elsewhere. The page has been refreshed.', refetch: true }],
  ['key_limit_reached', problem(422, 'key_limit_reached'), {}, { form: 'alert', message: 'You have 25 active keys. Revoke one to create another.' }],
  ['endpoint_limit_reached', problem(422, 'endpoint_limit_reached'), {}, { form: 'alert', message: 'You have 20 endpoints, the maximum. Delete one to add another.' }],
  ['currency_not_supported', problem(422, 'currency_not_supported'), {}, { form: 'alert', message: "That currency isn't supported for products yet." }],
  ['version_retired', problem(422, 'version_retired'), {}, { form: 'alert', message: "That version is retired and can't be pinned." }],
  ['idempotency_key_required', problem(422, 'idempotency_key_required', { requestId: 'r9' }), {}, { form: 'alert', message: SERVER, reference: 'r9' }],
  ['idempotency_key_reuse', problem(422, 'idempotency_key_reuse', { requestId: 'r9' }), {}, { form: 'alert', message: SERVER, reference: 'r9' }],
  ['rate_limited with Retry-After', problem(429, 'rate_limited', { retryAfterSeconds: 12 }), {}, { form: 'countdown', message: 'Too many requests. Try again in 12 s.', retryAfterSeconds: 12 }],
  ['rate_limited when opening a shop', problem(429, 'rate_limited', { retryAfterSeconds: 7 }), { subject: 'attempts' }, { form: 'countdown', message: 'Too many attempts. Try again in 7 s.' }],
  ['rate_limited on a test event', problem(429, 'rate_limited', { retryAfterSeconds: 3 }), { subject: 'test events' }, { form: 'countdown', message: 'Too many test events. Try again in 3 s.' }],
  ['rate_limited without Retry-After', problem(429, 'rate_limited'), {}, { form: 'countdown', message: 'Too many requests. Try again later.' }],
  ['too_many_connections', problem(429, 'too_many_connections', { retryAfterSeconds: 5 }), {}, { form: 'countdown', retryAfterSeconds: 5 }],
  ['upstream_unavailable on a read', problem(503, 'upstream_unavailable', { requestId: 'r2', retryAfterSeconds: 4 }), { kind: 'read' }, { form: 'page', message: "We couldn't load this right now. Try again in a moment.", reference: 'r2', retryAfterSeconds: 4 }],
  ['upstream_unavailable on a write', problem(503, 'upstream_unavailable', { requestId: 'r2' }), {}, { form: 'alert', message: "That didn't work. Try again in a moment.", reference: 'r2' }],
  ['upstream_invalid', problem(502, 'upstream_invalid', { requestId: 'r3' }), {}, { form: 'alert', reference: 'r3' }],
  ['overloaded', problem(503, 'overloaded'), {}, { form: 'alert', message: "That didn't work. Try again in a moment." }],
  ['service_unavailable', problem(503, 'service_unavailable'), { kind: 'read' }, { form: 'page' }],
  ['serialization_failure', problem(503, 'serialization_failure'), {}, { form: 'alert' }],
  ['cell_unavailable', problem(503, 'cell_unavailable'), {}, { form: 'alert' }],
  ['search_unavailable', problem(503, 'search_unavailable'), { kind: 'read' }, { form: 'page' }],
  ['realtime_unavailable', problem(503, 'realtime_unavailable'), {}, { form: 'alert' }],
  ['500 internal', problem(500, undefined, { requestId: 'r4' }), {}, { form: 'alert', message: SERVER, reference: 'r4' }],
  ['500 without a request id (body was not problem+json)', problem(500), {}, { form: 'alert', message: SERVER }],
  ['network failure', problem(0), {}, { form: 'alert', message: "Couldn't reach the server. Check your connection and try again." }],
  ['unknown 4xx', problem(418, 'teapot'), {}, { form: 'alert', message: "Something didn't work. Check the details and try again." }],
];

describe('W04 sellerProblemCopy: the error catalogue', () => {
  it.each(rows)('W04 AS-89: %s', (_name, p, context, expected) => {
    expect(sellerProblemCopy(p, context)).toMatchObject(expected);
  });

  it('W04 AS-89: 5xx and unknown errors carry the reference, other codes do not', () => {
    expect(sellerProblemCopy(problem(500, undefined, { requestId: 'abc' }), {}).reference).toBe('abc');
    expect(sellerProblemCopy(problem(409, 'last_owner', { requestId: 'abc' }), {}).reference).toBeUndefined();
    expect(sellerProblemCopy(problem(500), {}).reference).toBeUndefined();
  });

  it('W04 AS-89: the server detail is never part of the message, whatever the code', () => {
    for (const [, p, context] of rows) {
      const copy = sellerProblemCopy(p, { ...context, detail: 'SELECT * FROM secrets /srv/app.ts:42' });
      expect(JSON.stringify(copy), p.code ?? String(p.status)).not.toMatch(/SELECT|secrets|app\.ts/);
    }
  });

  it('W04 AS-59: endpoint_url_rejected is the one code that shows the API detail, at the URL field', () => {
    expect(sellerProblemCopy(problem(422, 'endpoint_url_rejected'), { detail: 'The host resolves to a private address.' })).toMatchObject({
      form: 'field',
      field: 'url',
      message: 'The host resolves to a private address.',
    });
  });

  it('W04 AS-61: endpoint_url_rejected when enabling is an alert, and without a detail has a fixed sentence', () => {
    expect(sellerProblemCopy(problem(422, 'endpoint_url_rejected'), { place: 'dialog', detail: 'Private address.' })).toMatchObject({ form: 'alert', message: 'Private address.' });
    expect(sellerProblemCopy(problem(422, 'endpoint_url_rejected'), {})).toMatchObject({ message: "This URL can't be used for webhooks." });
  });

  it('W04 AS-89: a fractional or hostile Retry-After becomes whole seconds, at least 1', () => {
    expect(sellerProblemCopy(problem(429, 'rate_limited', { retryAfterSeconds: 0.2 }), {}).message).toBe('Too many requests. Try again in 1 s.');
    expect(sellerProblemCopy(problem(429, 'rate_limited', { retryAfterSeconds: 11.2 }), {}).retryAfterSeconds).toBe(12);
  });

  it('W04 SC-006: no message is empty (except the silent refetch), contains JSON, a bare status or [object Object]', () => {
    for (const [name, p, context] of rows) {
      const copy = sellerProblemCopy(p, context);
      if (copy.silent) continue;
      expect(copy.message, name).not.toBe('');
      expect(copy.message, name).not.toMatch(/[{}]|\[object|^\d{3}$|undefined|null/);
    }
  });
});

describe('W04 problemDetailOf', () => {
  it('reads the detail string of an axios-like error, and nothing else', () => {
    expect(problemDetailOf({ response: { data: { detail: 'Bad host' } } })).toBe('Bad host');
    expect(problemDetailOf({ response: { data: { detail: 42 } } })).toBeUndefined();
    expect(problemDetailOf(new Error('x'))).toBeUndefined();
    expect(problemDetailOf({ response: { data: { detail: 'x'.repeat(500) } } })).toHaveLength(200);
  });
});
