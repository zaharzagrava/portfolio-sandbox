export function createEventStream(
  topics: string[],
  types: string[],
  onEvent: (topic: string, type: string, data: unknown) => void
) {
  const baseURL = process.env.NEXT_PUBLIC_SSE_URL || 'http://localhost:3000';
  const url = `${baseURL}/api/streams?topics=${encodeURIComponent(topics.join(','))}`;
  const es = new EventSource(url, { withCredentials: true });

  // Listen by message TYPE (what the server puts in `event:`); route by the topic inside the payload.
  for (const type of types) {
    es.addEventListener(type, (e) => {
      try {
        const { topic, data } = JSON.parse((e as MessageEvent).data);
        onEvent(topic, type, data);
      } catch (err) {
        console.error(`Failed to parse SSE data for type ${type}`, err);
      }
    });
  }

  // Don't close on error: the browser reconnects by itself (server sends `retry: 3000`)
  // and sends Last-Event-ID, so the server replays the gap.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      // Fatal (e.g. 401/403/404 or wrong content type): the browser won't retry.
      // Recreate later with backoff, after refreshing auth if needed.
      console.error('EventSource closed permanently.');
    }
  };

  return { close: () => es.close() };
}
