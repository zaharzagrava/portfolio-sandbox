import { z } from 'zod';

/**
 * S51 HTTP contracts (specs/domains/S51-realtime-push/contracts/stream-http.md): the stream request, the frame
 * payloads and the cursor carried by `id:` / `Last-Event-ID`.
 */

/** A topic as the client writes it: `<prefix>:<id>[:<suffix>]` or a bare singleton prefix. */
export const topicNameSchema = z.string().min(1).max(160);

/** `GET /api/streams?topics=a,b`: the only accepted query parameter; spaces trimmed, empty items dropped, duplicates collapsed, 1-10 distinct topics. */
export const streamQuerySchema = z
  .object({
    topics: z
      .string()
      .transform((raw) => [
        ...new Set(
          raw
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ])
      .pipe(z.array(topicNameSchema).min(1).max(10)),
  })
  .strict();

/** The `data:` of every event frame. */
export const streamEventEnvelopeSchema = z
  .object({ topic: topicNameSchema, data: z.unknown() })
  .strict();

export const resyncDataSchema = z
  .object({ reason: z.literal('replay-gap') })
  .strict();

export const revokedDataSchema = z.object({}).strict();

export const CURSOR_MAX_LENGTH = 2_048;
export const CURSOR_POSITION = /^\d{1,16}-\d{1,16}$/;
/** A cursor position may be at most this far ahead of the server clock. */
export const CURSOR_FUTURE_TOLERANCE_MS = 60_000;

/**
 * `<topic>~<ms>-<seq>` joined by `|`. Positions are `^\d{1,16}-\d{1,16}$`, never `0-0`, and not more than a minute
 * ahead of the clock. The `now` of the future check is read when parsing.
 */
export const cursorSchema = z
  .string()
  .max(CURSOR_MAX_LENGTH)
  .refine((raw) => {
    const parts = raw.split('|');
    return parts.every((part) => {
      const [topic, position, ...rest] = part.split('~');
      if (!topic || rest.length || !position) return false;
      if (!CURSOR_POSITION.test(position) || position === '0-0') return false;
      return (
        Number(position.split('-')[0]) <=
        Date.now() + CURSOR_FUTURE_TOLERANCE_MS
      );
    });
  });

export type StreamQuery = z.infer<typeof streamQuerySchema>;
export type StreamEventEnvelope = z.infer<typeof streamEventEnvelopeSchema>;
