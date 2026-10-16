import { API_URL, type JourneyClient } from './journey-client';
import { waitFor } from '../../utils/async-helpers';

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface OpenStream {
  events: StreamEvent[];
  /** Resolves with the first event (after `from`) the predicate accepts, within `timeoutMs`. */
  next(
    predicate: (e: StreamEvent) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<StreamEvent>;
  close(): void;
}

/**
 * Opens `GET /api/streams?topics=…` as the actor and collects events in the background until `close()`.
 * Resolves once the server has answered `200`, so events published after this returns are not missed.
 */
export async function openStream(
  actor: JourneyClient,
  topics: string,
): Promise<OpenStream> {
  const abort = new AbortController();
  const events: StreamEvent[] = [];
  const response = await fetch(
    `${API_URL}/api/streams?topics=${encodeURIComponent(topics)}`,
    {
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${actor.token}`,
      },
      signal: abort.signal,
    },
  );
  if (response.status !== 200) {
    abort.abort();
    throw new Error(`stream ${topics}: ${response.status}`);
  }
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          let event = 'message';
          let data: string | undefined;
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (data === undefined) continue;
          try {
            const frame = JSON.parse(data) as Record<string, unknown>;
            // the gateway wraps the payload as `{topic, data}`; tests see the payload
            events.push({
              event,
              data:
                typeof frame.topic === 'string' &&
                frame.data &&
                typeof frame.data === 'object'
                  ? (frame.data as Record<string, unknown>)
                  : frame,
            });
          } catch {
            events.push({ event, data: { raw: data } });
          }
        }
      }
    } catch {
      // closed by the test (abort) or by the server: nothing more to collect
    }
  })();
  return {
    events,
    next: async (predicate, timeoutMs, what) => {
      try {
        return await waitFor(async () => events.find(predicate), {
          timeoutMs,
          intervalMs: 100,
          description: `stream event ${what}`,
        });
      } catch (error) {
        throw new Error(
          `${(error as Error).message}; received: ${JSON.stringify(events)}`,
        );
      }
    },
    close: () => abort.abort(),
  };
}
