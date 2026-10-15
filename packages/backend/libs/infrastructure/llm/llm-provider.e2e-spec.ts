import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicLlmProvider } from './anthropic.provider';
import {
  LlmRejectedError,
  LlmRequest,
  LlmUnavailableError,
} from './llm-provider';
import { LlmCallRecorder } from './llm-call-recorder';

/** One scripted reaction of the local HTTP double to one request. */
type Step = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

interface Seen {
  url: string;
  body: Record<string, any>;
}

const MESSAGE = (text: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text, citations: null }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const status =
  (code: number, headers: Record<string, string> = {}): Step =>
  (_req, res) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `scripted ${code}` },
      }),
    );
  };

const json =
  (text: string): Step =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(MESSAGE(text)));
  };

const sseHead = (res: ServerResponse) =>
  res.writeHead(200, { 'content-type': 'text/event-stream' });
const sseEvent = (res: ServerResponse, type: string, data: object) =>
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const sseStart = (res: ServerResponse) => {
  sseHead(res);
  sseEvent(res, 'message_start', {
    message: { ...MESSAGE(''), content: [] },
  });
  sseEvent(res, 'content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
};
const sseDelta = (res: ServerResponse, text: string) =>
  sseEvent(res, 'content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text },
  });

const stream =
  (...pieces: string[]): Step =>
  (_req, res) => {
    sseStart(res);
    pieces.forEach((p) => sseDelta(res, p));
    sseEvent(res, 'content_block_stop', { index: 0 });
    sseEvent(res, 'message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    sseEvent(res, 'message_stop', {});
    res.end();
  };

/** Closes the socket without a response: a connection reset before any byte. */
const reset: Step = (req) => {
  req.socket.destroy();
};

/** Streams one token and then drops the connection. */
const dropAfterFirstToken: Step = (_req, res) => {
  sseStart(res);
  sseDelta(res, 'Hel');
  setTimeout(() => res.socket?.destroy(), 20);
};

/** Accepts the request and says nothing until `ms` have passed. */
const silent =
  (ms: number): Step =>
  (_req, res) => {
    setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) json('late')(_req, res);
    }, ms);
  };

const REQUEST: LlmRequest = {
  model: 'claude-sonnet-5-5',
  system: [{ type: 'text', text: 'You are terse.' }],
  tools: [],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};

describe('LLM provider port and Anthropic adapter', () => {
  let server: Server;
  let steps: Step[];
  let seen: Seen[];
  let waits: number[];
  let rateLimited: [string, number][];
  let provider: AnthropicLlmProvider;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
          /* not JSON */
        }
        seen.push({ url: req.url ?? '', body });
        const step = steps.shift() ?? status(500);
        void step(req, res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    steps = [];
    seen = [];
    waits = [];
    rateLimited = [];
    provider = new AnthropicLlmProvider('test-key', {
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      backoff: { baseMs: 100, maxMs: 1_000 },
      random: () => 0.5,
      // The waits are recorded, not slept: the spec asserts what was decided, not wall-clock time.
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      onRateLimited: (model, retryAfterMs) =>
        rateLimited.push([model, retryAfterMs]),
    });
  });

  const run = (request: Partial<LlmRequest> = {}) => {
    const text: string[] = [];
    const result = provider.streamTurn(
      { ...REQUEST, ...request },
      { signal: new AbortController().signal, onText: (t) => text.push(t) },
    );
    return { result, text };
  };

  describe('AS-50 retries', () => {
    it('S46 AS-50: a 429 with Retry-After is retried after waiting that long, and the next attempt is served', async () => {
      steps = [status(429, { 'retry-after': '2' }), stream('Hello', ' world')];

      const { result, text } = run();

      await expect(result).resolves.toMatchObject({
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      expect(text.join('')).toBe('Hello world');
      expect(seen).toHaveLength(2);
      expect(waits).toEqual([2_000]);
    });

    it('S46 AS-50: a 429 sets the model cooldown from Retry-After, and 5 s when the header is missing', async () => {
      steps = [status(429, { 'retry-after': '3' }), stream('ok')];
      await run().result;
      steps = [status(429), stream('ok')];
      const second = run();
      await second.result;

      expect(rateLimited).toEqual([
        ['claude-sonnet-5-5', 3_000],
        ['claude-sonnet-5-5', 5_000],
      ]);
      // No header: the retry uses the jittered default backoff (random 0.5 * 100 ms).
      expect(waits).toEqual([3_000, 50]);
    });

    it.each([502, 503, 504, 529])(
      'S46 AS-50: a %i before any token is retried once and then served',
      async (code) => {
        steps = [status(code), stream('ok')];

        await expect(run().result).resolves.toMatchObject({
          stopReason: 'end_turn',
        });

        expect(seen).toHaveLength(2);
        expect(waits).toEqual([50]);
      },
    );

    it('S46 AS-50: at most two retries: three attempts, then the typed transient error', async () => {
      steps = [status(503), status(503), status(503), stream('never')];

      await expect(run().result).rejects.toBeInstanceOf(LlmUnavailableError);

      expect(seen).toHaveLength(3);
      expect(waits).toEqual([50, 100]); // exponential, full jitter (random 0.5)
    });

    it('S46 AS-50: a connection reset before the first token is retried', async () => {
      steps = [reset, stream('back')];

      await expect(run().result).resolves.toMatchObject({
        stopReason: 'end_turn',
      });

      expect(seen).toHaveLength(2);
    });

    it('S46 AS-50: a first-token timeout is retried inside the deadline and then served', async () => {
      steps = [silent(1_500), stream('fast')];

      const { result, text } = run({ firstTokenTimeoutMs: 200 });

      await expect(result).resolves.toMatchObject({ stopReason: 'end_turn' });
      expect(text.join('')).toBe('fast');
      expect(seen).toHaveLength(2);
    });

    it.each([400, 401, 403, 404, 422])(
      'S46 AS-50: a %i is never retried and surfaces as LlmRejectedError',
      async (code) => {
        steps = [status(code), stream('never')];

        await expect(run().result).rejects.toBeInstanceOf(LlmRejectedError);

        expect(seen).toHaveLength(1);
        expect(waits).toEqual([]);
      },
    );

    it('S46 AS-50: nothing is retried after the first token was received', async () => {
      steps = [dropAfterFirstToken, stream('never')];

      const { result, text } = run();

      await expect(result).rejects.toBeInstanceOf(LlmUnavailableError);
      expect(text.join('')).toBe('Hel');
      expect(seen).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('S46 AS-50: maxRetries 0 makes exactly one attempt', async () => {
      steps = [status(503), stream('never')];

      await expect(run({ maxRetries: 0 }).result).rejects.toBeInstanceOf(
        LlmUnavailableError,
      );

      expect(seen).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('S46 AS-50: a Retry-After beyond the first-token deadline is not waited: one attempt, the typed error carries retryAfterMs', async () => {
      steps = [status(429, { 'retry-after': '60' }), stream('never')];

      const { result } = run({ firstTokenTimeoutMs: 1_000 });

      await expect(result).rejects.toMatchObject({
        name: 'LlmUnavailableError',
        retryAfterMs: 60_000,
      });
      expect(seen).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('S46 AS-50: an abort by the caller is LlmAbortedError, not a provider failure, and is not retried', async () => {
      steps = [silent(1_500), stream('never')];
      const controller = new AbortController();

      const result = provider.streamTurn(REQUEST, {
        signal: controller.signal,
        onText: () => undefined,
      });
      setTimeout(() => controller.abort(), 100);

      await expect(result).rejects.toMatchObject({ name: 'LlmAbortedError' });
      expect(seen).toHaveLength(1);
    });
  });

  describe('AS-77 the port is shared', () => {
    const SCHEMA = {
      type: 'object',
      properties: { iban: { type: 'string' } },
      required: ['iban'],
      additionalProperties: false,
    };
    const extraction = (): LlmRequest => ({
      model: 'claude-haiku-4-5',
      system: [{ type: 'text', text: 'Extract the fields.' }],
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'JVBERi0=',
              },
            },
            { type: 'text', text: 'Extract.' },
          ],
        },
      ],
      maxTokens: 2_000,
      effort: 'low',
      outputSchema: SCHEMA,
      timeoutMs: 45_000,
      maxRetries: 0,
    });

    let appended: any[];
    let recorder: LlmCallRecorder;

    beforeEach(() => {
      appended = [];
      const outbox = {
        append: (e: any) => void appended.push(e),
        appendStandalone: (e: any) => void appended.push(e),
      };
      recorder = new LlmCallRecorder(outbox as never);
    });

    it('S46 AS-77: complete() with maxRetries 0, timeout, output schema and a document block makes one attempt and one extraction record', async () => {
      steps = [json('{"iban":"X"}'), json('never')];
      const started = Date.now();

      const result = await provider.complete(extraction());
      const { billableTokens } = await recorder.record({
        subjectId: 'shop-1',
        scopeId: 'doc-1',
        callId: 'doc-1:1',
        purpose: 'extraction',
        metric: 'llm.extraction.tokens',
        requestedModel: 'claude-haiku-4-5',
        outcome: 'completed',
        result,
        ttftMs: null,
        durationMs: Date.now() - started,
      });

      expect(seen).toHaveLength(1);
      expect(seen[0].body.output_config.format).toMatchObject({
        type: 'json_schema',
        schema: SCHEMA,
      });
      expect(seen[0].body.messages[0].content[0].type).toBe('document');
      expect(billableTokens).toBe(15);
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        type: 'llm.call_completed',
        version: 1,
        aggregateId: 'doc-1:1',
        payload: {
          purpose: 'extraction',
          subjectId: 'shop-1',
          callId: 'doc-1:1',
          billableTokens: 15,
        },
      });
    });

    it('S46 AS-77: a transient failure surfaces as LlmUnavailableError {retryAfterMs} without internal retry or fallback', async () => {
      steps = [status(429, { 'retry-after': '7' }), json('never')];

      await expect(provider.complete(extraction())).rejects.toMatchObject({
        name: 'LlmUnavailableError',
        retryAfterMs: 7_000,
      });

      expect(seen).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('S46 AS-77: a non-transient failure surfaces as LlmRejectedError', async () => {
      steps = [status(400), json('never')];

      await expect(provider.complete(extraction())).rejects.toBeInstanceOf(
        LlmRejectedError,
      );

      expect(seen).toHaveLength(1);
    });

    it('S46 AS-77: the extraction timeout bounds the call (no internal retry after it)', async () => {
      steps = [silent(1_500), json('never')];

      await expect(
        provider.complete({ ...extraction(), timeoutMs: 200 }),
      ).rejects.toBeInstanceOf(LlmUnavailableError);

      expect(seen).toHaveLength(1);
    });
  });
});
