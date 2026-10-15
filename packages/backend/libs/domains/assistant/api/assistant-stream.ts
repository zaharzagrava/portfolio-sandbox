import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ApiConfigService } from '@app/common/config';
import {
  GENERATION_STORE,
  TERMINAL_EVENT_TYPES,
  type GenerationStore,
  type StoredEvent,
} from '../domain/assistant-ports';
import { GenerationService } from '../application/generation.service';

/** Viewer presence is refreshed this often; the generator's grace period is measured against it. */
const PRESENCE_REFRESH_MS = 500;
/** One blocking wait for new events; also how often an idle viewer checks that the generator is still alive. */
const MAX_WAIT_MS = 1_000;

const isTerminal = (event: StoredEvent) =>
  (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.event.type);

/**
 * Writes one generation to an SSE response (S46 FR-003, FR-004, FR-009): a viewer of the generation store, never its
 * owner. It replays after `Last-Event-ID`, follows live events, keeps its presence fresh for the generator's grace
 * period, writes `: ping` while silent, and reports a generator that is gone. The caller has already checked that the
 * generation exists and is the caller's.
 */
@Injectable()
export class AssistantStreamer {
  constructor(
    @Inject(GENERATION_STORE) private readonly store: GenerationStore,
    private readonly generations: GenerationService,
    private readonly config: ApiConfigService,
  ) {}

  async pipe(
    userId: string,
    messageId: string,
    lastEventId: string | undefined,
    res: Response,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...extraHeaders,
    });
    res.write('retry: 2000\n\n');

    const viewerId = randomUUID();
    const heartbeatMs = this.config.get('assistant_heartbeat_ms');
    let closed = false;
    let lastWrite = Date.now();
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(presence);
      clearInterval(heartbeat);
      void this.store
        .dropViewer(userId, messageId, viewerId)
        .catch(() => undefined);
      res.end();
    };
    // `res` close = the client went away (`req` close only means the POST body was read).
    res.on('close', finish);

    const touch = () =>
      this.store
        .touchViewer(userId, messageId, viewerId)
        .catch(() => undefined);
    const presence = setInterval(() => void touch(), PRESENCE_REFRESH_MS);
    const heartbeat = setInterval(() => {
      if (!closed && Date.now() - lastWrite >= heartbeatMs - 50) {
        res.write(': ping\n\n');
        lastWrite = Date.now();
      }
    }, heartbeatMs);
    await touch();

    const send = (stored: StoredEvent) => {
      res.write(
        `id: ${stored.id}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(stored.event.data)}\n\n`,
      );
      lastWrite = Date.now();
      if (isTerminal(stored)) finish();
    };

    try {
      let cursor = lastEventId ?? '0-0';
      while (!closed) {
        const events = await this.store.wait(
          userId,
          messageId,
          cursor,
          MAX_WAIT_MS,
        );
        if (closed) return;
        if (events === null) return finish();
        for (const stored of events) {
          if (closed) return;
          cursor = stored.id;
          send(stored);
        }
        if (!events.length) {
          // Nothing after the cursor and the generation is over: everything was delivered (AS-23).
          const meta = await this.store.meta(userId, messageId);
          if (!meta || meta.state !== 'running') {
            // The terminal event may have landed between the wait and this check: deliver what is left.
            for (const stored of (await this.store.read(
              userId,
              messageId,
              cursor,
              500,
            )) ?? [])
              if (!closed) send(stored);
            return finish();
          }
          const lost = await this.generations.reportIfLost(userId, messageId);
          // Lost, and this viewer won the report (or another did first and its event is read next round).
          if (lost) send(lost);
        }
      }
    } catch {
      finish();
    }
  }
}
