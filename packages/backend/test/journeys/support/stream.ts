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
  /** True once the server (or `close()`) ended the connection. */
  readonly closed: boolean;
  close(): void;
}

/**
 * Opens an SSE endpoint and collects events in the background until `close()` or until the server ends the connection.
 * Resolves once the server has answered `200`, so events published after this returns are not missed. The gateway wraps a
 * payload as `{topic, data}`; the events seen by a test carry the payload.
 */
export async function openSse(
  url: string,
  headers: Record<string, string> = {},
): Promise<OpenStream> {
  const abort = new AbortController();
  const events: StreamEvent[] = [];
  let closed = false;
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream', ...headers },
    signal: abort.signal,
  });
  if (response.status !== 200) {
    abort.abort();
    throw new Error(`stream ${url}: ${response.status}`);
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
    } finally {
      closed = true;
    }
  })();
  return {
    events,
    get closed() {
      return closed;
    },
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

/** `GET /api/streams?topics=…` as the actor. */
export function openStream(
  actor: JourneyClient,
  topics: string,
): Promise<OpenStream> {
  return openSse(`${API_URL}/api/streams?topics=${encodeURIComponent(topics)}`, {
    authorization: `Bearer ${actor.token}`,
  });
}
