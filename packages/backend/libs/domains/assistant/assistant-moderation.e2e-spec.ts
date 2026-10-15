import { Logger } from '@nestjs/common';
import { v4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { ProductQueryService } from '@app/domains/catalog';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  bootAssistant,
  data,
  type Harness,
  type TestUser,
} from './testing/assistant.harness';

const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

/** Everything the process logs while a spec runs; `restore()` puts the logger back. */
const captureLogs = () => {
  const lines: string[] = [];
  const spies = LEVELS.map((level) =>
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(' '));
      }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
};

describe('Shopping assistant: moderation and data hygiene', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootAssistant();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  const noSideEffect = async (u: TestUser, c: string) => {
    expect(h.llm.requests).toHaveLength(0);
    expect(await h.repository.messages(u.id, c)).toHaveLength(0);
    expect(await h.admission.lockHolder(u.id, c)).toBeNull();
    expect(await h.admission.slotMembers(u.id)).toEqual([]);
  };
  const rejected = (reason: string) =>
    MetricsRegistry.value('assistant_admission_rejected_total', { reason }) ??
    0;
  const messageId = (events: { data?: string }[]) =>
    JSON.parse(events[0].data!).messageId as string;

  it('S46 AS-52: flagged input is 422 input_rejected by category, with no side effect and no text in logs', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.moderation.flagInput = (text) =>
      text.includes('attack') ? 'violence' : null;
    const logs = captureLogs();
    try {
      const res = await h.ask(u, c, { text: 'I will attack someone tonight' });
      expect([res.status, res.body.code, res.body.category]).toEqual([
        422,
        'input_rejected',
        'violence',
      ]);
      expect(JSON.stringify(res.body)).not.toContain('attack someone');
      await noSideEffect(u, c);
      expect(logs.lines.join('\n')).not.toContain('attack someone');
    } finally {
      logs.restore();
    }
    const key = v4();
    expect(
      (await h.ask(u, c, { text: 'what phones are good?' }, { key })).status,
    ).toBe(200);
  });

  describe('S46 AS-53: card numbers and credentials are rejected as sensitive_data', () => {
    it.each([
      ['a card number with spaces', 'my card is 4111 1111 1111 1111 ok'],
      ['a card number with dashes', 'pay with 4111-1111-1111-1111'],
      [
        'a provider API key',
        'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      ],
      [
        'a bearer token',
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      ],
      [
        'an IBAN with a valid checksum',
        'send it to DE89 3704 0044 0532 0130 00',
      ],
    ])('%s', async (_name, text) => {
      const u = await h.user();
      const c = await h.conversation(u);
      const res = await h.ask(u, c, { text });
      expect([res.status, res.body.code, res.body.category]).toEqual([
        422,
        'input_rejected',
        'sensitive_data',
      ]);
      await noSideEffect(u, c);
    });

    it.each([
      ['a 12-digit order number', 'where is order 123456789012?'],
      ['a price', 'is €1,299.00 a fair price?'],
    ])('%s is accepted', async (_name, text) => {
      const u = await h.user();
      const c = await h.conversation(u);
      expect((await h.ask(u, c, { text })).status).toBe(200);
    });
  });

  it('S46 AS-54: a flagged chunk is not published; the reply ends in a moderation refusal; a split phrase is caught', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    // five chunks of 8 characters; the phrase "danger" straddles the 3rd and 4th
    h.moderation.flagOutput = (text, context) =>
      `${context ?? ''}${text}`.toLowerCase().includes('danger')
        ? 'hate'
        : null;
    h.llm.script({
      text: 'abcdefghijklmnopqrst-dander-zone-tail....'.replace(
        'dander',
        'danger',
      ),
      chunks: 5,
      delayMs: 80,
    });

    const res = await h.ask(u, c, { text: 'go' });

    const texts = res.events
      .filter((e) => e.event === 'text')
      .map((e) => data(e).t);
    expect(texts.join('')).not.toContain('ger');
    expect(texts.join('').startsWith('abcdefgh')).toBe(true);
    const last = res.events.at(-1)!;
    expect(last.event).toBe('refusal');
    expect(data(last)).toEqual({ category: 'hate', source: 'moderation' });
    expect(h.llm.aborted).toBe(1);
    expect(await h.repository.messages(u.id, c)).toHaveLength(0);
    expect(await h.admission.lockHolder(u.id, c)).toBeNull();
    expect(await h.admission.slotMembers(u.id)).toEqual([]);
    // the tokens used so far are charged and the call is recorded as aborted
    const m = messageId(res.events);
    const rows = await waitFor(
      async () => {
        const found = await outboxRowsFor(h.app, `${m}:1`);
        return found.length ? found : null;
      },
      { description: 'record written' },
    );
    const payload = ((rows[0].payload as { payload?: Record<string, unknown> })
      .payload ?? rows[0].payload) as Record<string, unknown>;
    expect(payload.outcome).toBe('aborted');
    expect(
      (await h.http().get('/api/assistant/usage').set(u.auth)).body.used,
    ).toBeGreaterThan(0);
  });

  describe('S46 AS-55: the moderation backend failing closes the door', () => {
    it('input: a backend that errors is 503 assistant_unavailable, counted and logged', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.moderation.fail = true;
      const before = rejected('moderation_unavailable');
      const logs = captureLogs();
      let res;
      try {
        res = await h.ask(u, c, { text: 'hello' });
        expect(logs.lines.join('\n')).toContain('moderation unavailable');
      } finally {
        logs.restore();
      }
      expect([res.status, res.body.code]).toEqual([
        503,
        'assistant_unavailable',
      ]);
      expect(rejected('moderation_unavailable')).toBe(before + 1);
      await noSideEffect(u, c);
    });

    it('input: a backend slower than the deadline is 503 too', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.moderation.stall = true;
      const started = Date.now();
      const res = await h.ask(u, c, { text: 'hello' });
      expect([res.status, res.body.code]).toEqual([
        503,
        'assistant_unavailable',
      ]);
      expect(Date.now() - started).toBeLessThan(2_000);
      await noSideEffect(u, c);
    });

    it('output: failing during a reply ends MODERATION_UNAVAILABLE and persists nothing', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.moderation.failOutput = true;
      h.llm.script({ text: 'an answer that cannot be checked', chunks: 2 });
      const before =
        MetricsRegistry.value('assistant_turns_total', {
          outcome: 'moderation_unavailable',
        }) ?? 0;
      const logs = captureLogs();
      let res;
      try {
        res = await h.ask(u, c, { text: 'hello' });
        expect(logs.lines.join('\n')).toContain(
          'moderation unavailable during the reply',
        );
      } finally {
        logs.restore();
      }
      expect(res.events.filter((e) => e.event === 'text')).toHaveLength(0);
      expect(data(res.events.at(-1)!)).toEqual({
        code: 'MODERATION_UNAVAILABLE',
      });
      expect(await h.repository.messages(u.id, c)).toHaveLength(0);
      expect(await h.admission.lockHolder(u.id, c)).toBeNull();
      await waitFor(
        async () =>
          (MetricsRegistry.value('assistant_turns_total', {
            outcome: 'moderation_unavailable',
          }) ?? 0) ===
          before + 1,
        { description: 'turn counted' },
      );
    });
  });

  it('S46 AS-56: provider requests carry no email, id, token, IP, coordinates or seller-private field', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    const shop = await createShop(h.app, null);
    const p = await createProduct(h.app, shop, {
      externalSku: 'SKU-PRIVATE-77',
    });
    h.llm.script(
      { toolUses: [{ name: 'product_details', input: { product_id: p.id } }] },
      { text: 'Here you go.' },
    );

    const res = await h.ask(u, c, {
      text: 'tell me about it',
      lat: 52.5170365,
      lng: 13.3888599,
    });
    expect(res.events.at(-1)!.event).toBe('done');

    const sent = JSON.stringify(h.llm.requests);
    for (const forbidden of [
      u.id,
      u.email,
      u.auth.Authorization.replace('Bearer ', ''),
      '127.0.0.1',
      '::1',
      '52.5170365',
      '13.3888599',
      shop.id,
      'SKU-PRIVATE-77',
      'externalSku',
    ])
      expect(sent).not.toContain(forbidden);
    // the frozen system prompt has no date, name or id
    expect(JSON.stringify(h.llm.requests[0].system)).not.toMatch(
      /\d{4}-\d{2}-\d{2}/,
    );
    // only an opaque per-user hash identifies the shopper to the provider
    for (const request of h.llm.requests) {
      expect(request.endUserHash).toMatch(/^[0-9a-f]{32}$/);
      expect(request.endUserHash).not.toContain(
        u.id.replace(/-/g, '').slice(0, 12),
      );
    }
    expect(new Set(h.llm.requests.map((r) => r.endUserHash)).size).toBe(1);
  });

  it('S46 AS-57: logs hold no message text, answers, tool data, coordinates or keys; turn lines carry the ids', async () => {
    const u = await h.user();
    const secrets = {
      text: 'USERTEXT-ALPHA-1',
      answer: 'ANSWER-BETA-2',
      toolArg: 'TOOLARG-GAMMA-3',
      toolError: 'TOOLERROR-DELTA-4',
      lat: '52.123456',
      lng: '13.654321',
      key: 'sk-ant-LOGKEY-EPSILON-5',
    };
    h.config.set('anthropic_api_key', secrets.key);
    const failing = jest
      .spyOn(h.app.get(ProductQueryService), 'getProductsByIds')
      .mockRejectedValueOnce(new Error(`db exploded ${secrets.toolError}`));
    const logs = captureLogs();
    try {
      // success with a failing tool
      const c1 = await h.conversation(u);
      h.llm.script(
        {
          toolUses: [{ name: 'product_details', input: { product_id: v4() } }],
        },
        { text: secrets.answer },
      );
      const ok = await h.ask(u, c1, {
        text: `${secrets.text} ${secrets.toolArg}`,
        lat: 52.123456,
        lng: 13.654321,
      });
      expect(ok.events.at(-1)!.event).toBe('done');
      // refusal
      const c2 = await h.conversation(u);
      h.llm.script({ text: '', stopReason: 'refusal' });
      expect(
        (await h.ask(u, c2, { text: secrets.text })).events.at(-1)!.event,
      ).toBe('refusal');
      // provider error
      const c3 = await h.conversation(u);
      h.llm.script({ rejected: true });
      expect(
        (await h.ask(u, c3, { text: secrets.text })).events.at(-1)!.event,
      ).toBe('error');
      // moderation rejection of the input
      h.moderation.flagInput = () => 'illegal';
      const c4 = await h.conversation(u);
      expect((await h.ask(u, c4, { text: secrets.text })).status).toBe(422);
    } finally {
      logs.restore();
      failing.mockRestore();
    }

    const all = logs.lines.join('\n');
    for (const [name, secret] of Object.entries(secrets))
      expect([name, all.includes(secret)]).toEqual([name, false]);
    expect(all).not.toContain(u.auth.Authorization.replace('Bearer ', ''));

    const turnLines = logs.lines.filter((l) => l.includes('messageId='));
    expect(turnLines.length).toBeGreaterThanOrEqual(2);
    for (const line of turnLines) {
      expect(line).toMatch(/requestId=\S+/);
      expect(line).not.toContain('requestId=-');
      expect(line).toMatch(/conversationId=[0-9a-f-]{36}/);
    }
    // the failing tool and the rejected provider call each left a line with the model-call id
    expect(
      turnLines.some(
        (l) =>
          l.includes('tool product_details failed') && /callId=\S+:1/.test(l),
      ),
    ).toBe(true);
    expect(
      turnLines.some(
        (l) =>
          l.includes('provider rejected a call') &&
          /callId=|messageId=/.test(l),
      ),
    ).toBe(true);
  });
});
