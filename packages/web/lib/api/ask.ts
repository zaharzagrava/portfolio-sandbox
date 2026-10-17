import { ragStreamEventSchema, type RagSource, type RagStreamEvent } from '@marketplace-sandbox/contracts';
import { endSession } from '@/lib/auth/session-ended';
import { problemFromError } from './errors';
import { believesSignedIn } from './session-presence';
import { streamSse } from './sse-reader';

export type { RagSource, RagStreamEvent };

const KNOWN_EVENTS = new Set<string>(ragStreamEventSchema.options.map((option) => option.shape.event.value));
const TERMINAL_EVENTS = new Set<string>(['done', 'not_found', 'refusal', 'error']);

/** A refusal before a stream opens, shaped like an axios error so `problemFromError` reads it (status, `code`, `requestId`, `Retry-After`). */
class AskRejected extends Error {
  readonly response: { status: number; data: unknown; headers: Record<string, string> };
  constructor(status: number, data: unknown, headers: Record<string, string>) {
    super(`ask rejected: ${status}`);
    this.name = 'AskRejected';
    this.response = { status, data, headers };
  }
}

async function rejectionOf(response: Response): Promise<AskRejected> {
  const data: unknown = await response.json().catch(() => null);
  const retryAfter = response.headers.get('retry-after');
  return new AskRejected(response.status, data, retryAfter === null ? {} : { 'retry-after': retryAfter });
}

const INTERNAL: RagStreamEvent = { event: 'error', code: 'INTERNAL' };

/**
 * `POST /api/products/{productId}/ask` (S47) and the read of its event stream (W02 FR-100, FR-101). The component never
 * touches the network: it gets validated events through `onEvent`, in order, and at most one terminal event
 * (`done`, `not_found`, `refusal`, `error`); the stream that ends without one is the caller's to treat as cut off.
 *
 * - an unknown event name is ignored; an event whose data is not JSON, or breaks `ragStreamEventSchema`, ends the answer
 *   as an in-stream `error {INTERNAL}` and nothing after it is read;
 * - a request refused before a stream opens (`404`, `422`, `429`, `503`, `400`, ...) rejects with an error that
 *   `problemFromError` understands; a network failure rejects with a status 0 problem; aborting `signal` rejects with
 *   the `AbortError` (the connection closes);
 * - the CSRF header and the session cookie are added by `streamSse`; no token travels from JavaScript.
 */
export function askProduct(productId: string, question: string, options: { signal: AbortSignal; onEvent: (event: RagStreamEvent) => void }): Promise<void> {
  return askStream(`/api/products/${encodeURIComponent(productId)}/ask`, question, options);
}

/** The same stream for any S47 ask route (W04 uses `/api/shops/{shopId}/knowledge/ask`). */
export async function askStream(
  path: string,
  question: string,
  { signal, onEvent }: { signal: AbortSignal; onEvent: (event: RagStreamEvent) => void },
): Promise<void> {
  // Our own controller lets us close the connection when the stream turns out to be unusable.
  const ours = new AbortController();
  const forward = () => ours.abort();
  if (signal.aborted) ours.abort();
  else signal.addEventListener('abort', forward, { once: true });

  let ended = false;
  const deliver = (event: RagStreamEvent) => {
    if (ended) return;
    if (TERMINAL_EVENTS.has(event.event)) ended = true;
    onEvent(event);
  };
  const fail = () => {
    deliver(INTERNAL);
    ours.abort();
  };

  try {
    const response = await streamSse(
      path,
      { body: { question: question.trim() }, signal: ours.signal },
      (raw) => {
        if (ended || !KNOWN_EVENTS.has(raw.event)) return;
        let data: unknown;
        try {
          data = JSON.parse(raw.data);
        } catch {
          fail();
          return;
        }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return fail();
        const parsed = ragStreamEventSchema.safeParse({ ...data, event: raw.event });
        if (parsed.success) deliver(parsed.data);
        else fail();
      },
    );
    if (!response.ok) throw await rejectionOf(response);
  } catch (error) {
    // Our own close after an unusable event is not a failure of the call.
    if (ended && !signal.aborted && ours.signal.aborted) return;
    if (problemFromError(error).status === 401 && believesSignedIn()) endSession();
    throw error;
  } finally {
    signal.removeEventListener('abort', forward);
  }
}
