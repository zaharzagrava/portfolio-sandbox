import type { Problem } from '@/lib/api/errors';
import { CLOSING_COPY, SUSPENDED_COPY } from './permissions';

/**
 * The visible form and text of every problem a W04 screen can meet (spec "Error catalogue", FR-043, SC-006), chosen by the
 * stable `code` and the status. It wraps W01's `Problem`; the server's `title` and `detail` are never shown, with the one
 * exception of `endpoint_url_rejected`, whose `detail` the caller passes in `context.detail`.
 */

export type SellerProblemForm = 'field' | 'alert' | 'page' | 'toast' | 'session' | 'countdown';
/** What the screen offers next, besides the text: the component renders the matching control or link. */
export type SellerProblemAction = 'first-page' | 'two-step' | 'load-latest' | 'end-old-secret';

export type SellerProblemContext = {
  /** `read` (default `write`): a page or section that failed to load, against an action that failed. */
  kind?: 'read' | 'write';
  /** Where it is shown: a whole page, an open dialog, or the live stream. */
  place?: 'page' | 'dialog' | 'stream';
  /** Who is waiting in a `429` sentence ("Too many {subject}"). */
  subject?: 'requests' | 'attempts' | 'test events';
  /** What the call acted on, for codes whose words depend on it (`invalid_transition`). */
  resource?: 'campaign' | 'document' | 'draft' | 'photos';
  /** The API's `detail`; used for `endpoint_url_rejected` only. */
  detail?: string;
};

export type SellerProblemCopy = {
  form: SellerProblemForm;
  message: string;
  /** For `form: 'field'`: the form field the message belongs to (the first one named by `errors[]`, or the code's own). */
  field?: string;
  action?: SellerProblemAction;
  /** The list or page behind the action is out of date: refetch it. */
  refetch?: boolean;
  /** The refetch needs no message. */
  silent?: boolean;
  /** `requestId`, shown as "Reference: …" (5xx and unknown errors). */
  reference?: string;
  /** Whole seconds to wait (`Retry-After`, rounded up, at least 1). */
  retryAfterSeconds?: number;
};

const SERVER = 'Something went wrong on our side.';
const UNAVAILABLE_READ = "We couldn't load this right now. Try again in a moment.";
const UNAVAILABLE_WRITE = "That didn't work. Try again in a moment.";
const OFFLINE = "Couldn't reach the server. Check your connection and try again.";
const FALLBACK_4XX = "Something didn't work. Check the details and try again.";
const STALE_PRODUCT = 'This product was archived or restored elsewhere. The list has been refreshed.';

const UNAVAILABLE_CODES = new Set(['upstream_unavailable', 'upstream_invalid', 'overloaded', 'service_unavailable', 'serialization_failure', 'cell_unavailable', 'search_unavailable']);
const GENERIC_CODES = new Set(['shop_mismatch', 'invalid_topics', 'invalid_query', 'invalid_limit', 'idempotency_key_required', 'idempotency_key_reuse']);
const SESSION_CODES = new Set(['unauthenticated', 'invalid_token', 'session_expired']);

type Entry = { form: SellerProblemForm; message: string; field?: string; action?: SellerProblemAction; refetch?: boolean; silent?: boolean };
const alert = (message: string, extra: Partial<Entry> = {}): Entry => ({ form: 'alert', message, ...extra });

/** Codes with one fixed answer, whatever the screen. */
const FIXED: Record<string, Entry> = {
  invalid_cursor: { form: 'page', message: 'That page link is no longer valid.', action: 'first-page' },
  insufficient_role: alert("You can't change this member's role."),
  mfa_required: alert('Live keys need two-step verification.', { action: 'two-step' }),
  shop_suspended: alert(SUSPENDED_COPY, { refetch: true }),
  shop_offboarding: alert(CLOSING_COPY, { refetch: true }),
  product_not_found: alert('This product no longer exists.', { refetch: true }),
  member_not_found: { form: 'toast', message: 'This member is no longer in the team.', refetch: true },
  webhook_endpoint_not_found: { form: 'toast', message: 'This endpoint was already deleted.', refetch: true },
  webhook_event_not_found: alert('This event is older than 30 days or no longer available.'),
  resource_missing: { form: 'toast', message: 'This key no longer exists.', refetch: true },
  invite_not_found: {
    form: 'page',
    message: "This invitation isn't valid for this account. It may have expired, been used, or been sent to a different e-mail address.",
  },
  not_ranked: { form: 'page', message: 'Not ranked yet. Your shop appears on the leaderboard after its first paid order.' },
  version_conflict: alert('This product changed since you opened it.', { action: 'load-latest' }),
  product_archived: alert(STALE_PRODUCT, { refetch: true }),
  invalid_transition: alert(STALE_PRODUCT, { refetch: true }),
  invalid_state: alert("This video can't be changed in its current state. The list has been refreshed.", { refetch: true }),
  key_revoked: alert('This key is already revoked.', { refetch: true }),
  key_expired: alert('This key has expired.', { refetch: true }),
  key_already_rotating: alert('This key is already being rotated.', { refetch: true }),
  endpoint_state_conflict: { form: 'toast', message: 'The endpoint was changed elsewhere. The list has been refreshed.', refetch: true },
  rotation_in_progress: alert('A previous secret is still valid. End it first or wait.', { action: 'end-old-secret' }),
  no_previous_secret: { form: 'toast', message: '', refetch: true, silent: true },
  endpoint_disabled: alert('Enable the endpoint first.'),
  idempotency_in_flight: alert('This replay is already being processed.'),
  duplicate_endpoint_url: { form: 'field', field: 'url', message: 'You already have an endpoint with this URL.' },
  slug_taken: { form: 'field', field: 'slug', message: 'That handle is taken. Try another.' },
  slug_reserved: { form: 'field', field: 'slug', message: 'That handle is reserved. Try another.' },
  shop_limit_reached: alert('You already own 10 shops.'),
  plan_limit_reached: alert('Your plan has reached its product limit. Upgrade the plan to add more products.'),
  seat_limit_reached: alert('Your plan has no free seats.'),
  invite_pending: alert('An invitation is already pending for this address.'),
  already_member: alert('This person is already a member.'),
  last_owner: alert('A shop needs at least one owner.'),
  stale_version: { form: 'toast', message: 'This changed elsewhere. The page has been refreshed.', refetch: true },
  key_limit_reached: alert('You have 25 active keys. Revoke one to create another.'),
  endpoint_limit_reached: alert('You have 20 endpoints, the maximum. Delete one to add another.'),
  currency_not_supported: alert("That currency isn't supported for products yet."),
  known_at_in_future: alert('Pick a day that is not in the future.'),
  month_not_available: alert('There is no statement for that month.'),
  too_many_active_imports: alert('You already have imports running. Wait for one to finish.'),
  import_not_found: alert('This import no longer exists.', { refetch: true }),
  import_not_uploadable: alert('This import can no longer receive the file. Start a new import.', { refetch: true }),
  import_not_completable: alert('This import was cancelled or has expired. Start a new import.', { refetch: true }),
  import_not_cancellable: alert('This import has already finished.', { refetch: true }),
  invalid_parts: alert('The upload did not match. Start a new import.'),
  size_mismatch: alert('The uploaded file does not have the size it was started with. Start a new import.'),
  error_report_not_ready: alert('The error report is not ready yet.', { refetch: true }),
  import_error_report_not_found: alert('This import has no error report.'),
  export_already_active: alert('An export is already running.', { refetch: true }),
  export_not_found: alert('This export no longer exists.', { refetch: true }),
  export_not_ready: alert('The file is not ready yet.', { refetch: true }),
  export_expired: alert('This file has expired. Start a new export.', { refetch: true }),
  export_not_cancellable: alert('This export has already finished.', { refetch: true }),
  version_retired:alert("That version is retired and can't be pinned."),
  // S36 campaigns
  campaign_not_found: { form: 'toast', message: 'This campaign no longer exists.', refetch: true },
  campaign_already_exists: alert('This product already has a campaign. Pause or end it, or pick another product.'),
  budget_below_cpc: { form: 'field', field: 'dailyBudgetMinor', message: 'The daily budget must be at least the cost per click.' },
  campaign_limit_reached: alert('You have the maximum number of open campaigns. End one to create another.'),
  product_not_sponsorable: alert("This product can't be sponsored. It may be archived or in a sandbox shop."),
  product_unavailable: alert('The product is not available, so the campaign cannot run. Restore the product first.', { refetch: true }),
  shop_inactive: alert('The shop must be active to resume a campaign.', { refetch: true }),
  // S06 listing drafts
  listing_invalid: alert('Some fields need attention before this draft can be published.'),
  publish_in_progress: alert('This draft is being published already. Check the versions in a moment.', { refetch: true }),
  request_in_flight: alert('This publish is already being processed. Wait a moment.'),
  version_limit_reached: alert('This draft has the maximum number of saved versions.'),
  draft_limit_reached: alert('You have the maximum number of open drafts. Archive one to start another.'),
  draft_not_found: { form: 'page', message: 'This draft no longer exists.' },
  collab_unavailable: alert('Live editing is unavailable right now. Try again in a moment.'),
  // S08 integrations, S09 offline conflicts
  invalid_store_url: { form: 'field', field: 'storeUrl', message: 'Enter the address of a WooCommerce store, like https://shop.example.com.' },
  provider_credentials_rejected: alert('The store rejected these keys. Check the consumer key and secret and try again.'),
  currency_mismatch: alert("The store's currency doesn't match this shop's currency."),
  store_already_connected: alert('This store is already connected to a shop.'),
  integration_limit_reached: alert("You've reached the maximum number of integrations. Disconnect one to add another."),
  provider_unavailable: alert("The store isn't answering right now. Try again in a moment."),
  integration_not_found: { form: 'page', message: 'This integration was disconnected or does not exist.' },
  invalid_integration_transition: alert("This integration can't do that in its current state. The page has been refreshed.", { refetch: true }),
  quarantine_not_found: { form: 'toast', message: 'This item no longer exists.', refetch: true },
  quarantine_not_open: alert('This item was already handled. The list has been refreshed.', { refetch: true }),
  conflict_not_found: { form: 'toast', message: 'This conflict no longer exists.', refetch: true },
  conflict_not_open: alert('This conflict was already dismissed. The list has been refreshed.', { refetch: true }),
  report_not_found: alert('This reconciliation report is no longer available.'),
  invalid_uuid: { form: 'page', message: "This link isn't valid." },
  // S29 photos, S30 video
  media_not_attachable: alert("Some photos aren't ready yet or no longer exist. Remove them or wait for them to finish, then save again.", { refetch: true }),
  media_not_found: { form: 'toast', message: 'This photo no longer exists.', refetch: true },
  pending_uploads_limit: alert('You have too many uploads waiting. Let them finish, then try again.'),
  upload_incomplete: alert("The file didn't arrive completely. Upload it again."),
  upload_expired: alert('This upload has expired. Start a new one.'),
  upload_closed: alert('This upload is closed. Start a new one.', { refetch: true }),
  video_not_found: { form: 'toast', message: 'This video no longer exists.', refetch: true },
  product_video_limit: alert('This product already has the maximum number of videos. Delete one to add another.'),
  not_retryable: alert("This video can't be processed again.", { refetch: true }),
  retry_limit: alert('This video has been retried too many times. Upload it again.', { refetch: true }),
  source_purged: alert('The original file is gone, so this video cannot be processed again. Upload it again.', { refetch: true }),
  parts_mismatch: alert("The uploaded parts didn't match. Start a new upload."),
  storage_unavailable: alert('Storage is unavailable right now. Try again in a moment.'),
  // S44 widget sites
  widget_site_not_found: { form: 'toast', message: 'This site was already deleted.', refetch: true },
  site_limit_reached: alert('You have the maximum number of widget sites. Delete one to add another.'),
  site_version_conflict: alert('This site changed since you opened it.', { action: 'load-latest' }),
  origin_invalid: { form: 'field', field: 'origins', message: "One of the addresses can't be used." },
  featured_product_invalid: { form: 'field', field: 'featuredProductIds', message: 'One of the featured products is not available in this shop.' },
  // S47 knowledge documents
  not_found: { form: 'toast', message: 'This document no longer exists.', refetch: true },
  upload_missing: alert("The file hasn't arrived yet. Upload it again."),
  document_limit_reached: alert('You have the maximum number of documents. Delete one to add another.'),
  product_document_must_be_public: { form: 'field', field: 'visibility', message: 'A document about a product must be public.' },
  input_rejected: alert("That question can't be answered here. Rephrase it and try again."),
  assistant_busy: alert('The assistant is busy. Try again in a moment.'),
};

/** `invalid_transition` means a stale list for a product, a campaign or a document: the words differ. */
const TRANSITION_COPY: Record<string, string> = {
  campaign: 'This campaign changed since the list was loaded. The list has been refreshed.',
  document: "This document can't be changed in its current state. The list has been refreshed.",
  draft: 'This draft was already published or archived.',
};

const whole = (seconds: number | undefined): number | undefined =>
  seconds === undefined || !Number.isFinite(seconds) ? undefined : Math.max(1, Math.ceil(seconds));

function entryFor(problem: Problem, context: SellerProblemContext): Entry {
  const { status, code } = problem;
  const read = context.kind === 'read';
  if (status === 0) return alert(OFFLINE);
  if (status === 401 || (code && SESSION_CODES.has(code))) return { form: 'session', message: 'Your session ended. Sign in again to continue.' };
  if (code === 'validation_failed') {
    const first = problem.errors[0];
    return first ? { form: 'field', field: first.field, message: 'Check this field.' } : alert('Check the details and try again.');
  }
  if (code === 'permission_denied') {
    return context.place === 'page' ? { form: 'page', message: "You don't have access to this page." } : { form: 'toast', message: "You don't have permission to do that." };
  }
  if (code === 'forbidden' && context.place === 'stream') return alert("Live numbers aren't available right now. Showing today's totals.");
  if (code === 'shop_not_found') {
    return context.place === 'dialog' ? alert('This shop is no longer available.') : { form: 'page', message: "We couldn't find that shop." };
  }
  if (code === 'endpoint_url_rejected') {
    const message = context.detail?.trim().slice(0, 200) || "This URL can't be used for webhooks.";
    return context.place === 'dialog' ? alert(message) : { form: 'field', field: 'url', message };
  }
  if (code === 'rate_limited' || code === 'too_many_connections' || status === 429) {
    const seconds = whole(problem.retryAfterSeconds);
    const subject = context.subject ?? 'requests';
    return { form: 'countdown', message: `Too many ${subject}. ${seconds ? `Try again in ${seconds} s.` : 'Try again later.'}` };
  }
  if (code === 'version_conflict' && context.resource === 'photos') return alert('The photos changed since you opened this page.', { action: 'load-latest' });
  if (code === 'invalid_transition' && context.resource) return alert(TRANSITION_COPY[context.resource] ?? FALLBACK_4XX, { refetch: true });
  const fixed = code && Object.hasOwn(FIXED, code) ? FIXED[code] : undefined;
  if (fixed) return fixed;
  if (code && GENERIC_CODES.has(code)) return alert(SERVER);
  if ((code && UNAVAILABLE_CODES.has(code)) || status === 502 || status === 503 || (code?.startsWith('realtime_') ?? false)) {
    return read ? { form: 'page', message: UNAVAILABLE_READ } : alert(UNAVAILABLE_WRITE);
  }
  if (status >= 500) return read ? { form: 'page', message: SERVER } : alert(SERVER);
  return alert(FALLBACK_4XX);
}

/** Whether the screen should show the request reference: 5xx, unknown codes, and the codes that mean a programming error. */
function showsReference(problem: Problem): boolean {
  if (!problem.requestId || problem.status === 0) return false;
  const code = problem.code;
  return problem.status >= 500 || !code || GENERIC_CODES.has(code) || !(Object.hasOwn(FIXED, code) ||SESSION_CODES.has(code) || KNOWN_OTHER.has(code));
}
const KNOWN_OTHER = new Set(['validation_failed', 'permission_denied', 'forbidden', 'shop_not_found', 'endpoint_url_rejected', 'rate_limited', 'too_many_connections']);

export function sellerProblemCopy(problem: Problem, context: SellerProblemContext = {}): SellerProblemCopy {
  const entry = entryFor(problem, context);
  const seconds = whole(problem.retryAfterSeconds);
  return {
    ...entry,
    ...(showsReference(problem) ? { reference: problem.requestId } : {}),
    ...(seconds !== undefined && (entry.form === 'countdown' || problem.status >= 500) ? { retryAfterSeconds: seconds } : {}),
  };
}

/**
 * The API's `detail` of a failed call, clipped to 200 characters. For `endpoint_url_rejected` only: it is the one problem
 * whose own words the seller needs (why the URL was refused).
 */
export function problemDetailOf(error: unknown): string | undefined {
  const detail = (error as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  return typeof detail === 'string' ? detail.slice(0, 200) : undefined;
}
