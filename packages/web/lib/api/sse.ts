/** In-band events the stream hub sends on its own (S51 FR-009): handled whatever `types` the page asks for. */
const HUB_EVENTS = ['resync', 'revoked'];
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function createEventStream(
  topics: string[],
  types: string[],
  onEvent: (topic: string, type: string, data: unknown) => void
) {
  const baseURL = process.env.NEXT_PUBLIC_SSE_URL || 'http://localhost:3000';
  const url = `${baseURL}/api/streams?topics=${encodeURIComponent(topics.join(','))}`;
  let es: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let stopped = false;

  const connect = () => {
    const source = new EventSource(url, { withCredentials: true });
    es = source;
    // Listen by message TYPE (what the server puts in `event:`); route by the topic inside the payload.
    // `resync` (refetch: the replay buffer cannot cover the gap) and `revoked` (access to that topic ended) always arrive.
    for (const type of new Set([...types, ...HUB_EVENTS])) {
      source.addEventListener(type, (e) => {
        failures = 0;
        try {
          const { topic, data } = JSON.parse((e as MessageEvent).data);
          onEvent(topic, type, data);
        } catch (err) {
          console.error(`Failed to parse SSE data for type ${type}`, err);
        }
      });
    }

    // A transient error: the browser reconnects by itself (the server sends a jittered `retry:`) and sends
    // Last-Event-ID, so the server replays the gap. A final one (401/403, wrong content type) closes the source and the
    // browser never retries: recreate it with backoff so a refreshed session resumes the stream.
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED || stopped) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** failures);
      failures += 1;
      timer = setTimeout(connect, delay);
    };
  };
  connect();

  return {
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
    },
  };
}
