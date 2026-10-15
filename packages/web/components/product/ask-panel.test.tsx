import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AskPanel } from '@/components/product/ask-panel';

const PRODUCT = '0192f7a0-0000-7000-8000-00000000c001';
const QUESTION = 'Does the lantern battery last 40 hours?';
const encoder = new TextEncoder();

const source = (n: number, over: Record<string, unknown> = {}) => ({
  n,
  chunkId: `c${n}`,
  documentId: `d${n}`,
  title: 'Lantern manual',
  headingPath: 'Battery',
  page: null,
  ...over,
});

/** One scripted answer: the test pushes events and decides when the stream ends; aborting the request errors the read. */
type Scripted = {
  push: (event: string, data: unknown) => void;
  raw: (text: string) => void;
  end: () => void;
  readonly aborted: boolean;
  readonly body: unknown;
};
type Next = { scripted: Scripted; make: (signal: AbortSignal | undefined, body: unknown) => Response };

let queue: Next[];
let fetchSpy: MockInstance<typeof fetch>;

function openStream(): Scripted {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let aborted = false;
  let body: unknown;
  const scripted: Scripted = {
    push: (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    raw: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    get aborted() {
      return aborted;
    },
    get body() {
      return body;
    },
  };
  queue.push({
    scripted,
    make: (signal, sent) => {
      body = sent;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          signal?.addEventListener('abort', () => {
            aborted = true;
            c.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  return scripted;
}

function refuseWith(status: number, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  queue.push({
    scripted: undefined as unknown as Scripted,
    make: () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json', ...headers } }),
  });
}

/** A whole answer in one go, ending after its last event. */
function answerWith(events: [string, unknown][]) {
  const scripted = openStream();
  return {
    scripted,
    play: () => {
      for (const [event, data] of events) scripted.push(event, data);
      scripted.end();
    },
  };
}

beforeEach(() => {
  queue = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    return next.make(init?.signal ?? undefined, JSON.parse(String(init?.body ?? 'null')));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const questionField = () => screen.getByRole('textbox', { name: 'Your question' });
const answerRegion = () => screen.getByRole('region', { name: 'Answer' });
const status = () => screen.getByRole('status');

async function type(text = QUESTION) {
  const user = userEvent.setup();
  await user.type(questionField(), text);
  return user;
}
async function ask(text = QUESTION) {
  const user = await type(text);
  await user.click(screen.getByRole('button', { name: 'Ask' }));
  return user;
}

describe('W02 ask panel', () => {
  it('W02 AS-54: shows the lead, the labelled field and Ask, which needs a trimmed question of 3 to 500 characters', async () => {
    render(<AskPanel productId={PRODUCT} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Ask about this product' })).toBeInTheDocument();
    expect(screen.getByText("Answers come from this product's documents.")).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Ask' });
    expect(button).toBeDisabled();
    const user = userEvent.setup();
    await user.type(questionField(), '  ab  ');
    expect(button).toBeDisabled();
    await user.type(questionField(), 'c');
    expect(button).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Answer' })).not.toBeInTheDocument();
  });

  it('W02 AS-54: a counter appears within 50 characters of the limit, counts code points, and Ask is off above 500', async () => {
    render(<AskPanel productId={PRODUCT} />);
    expect(screen.queryByText(/characters? left/)).not.toBeInTheDocument();
    const field = questionField();
    await userEvent.setup().click(field);
    await userEvent.setup().paste('a'.repeat(449));
    expect(screen.queryByText(/characters? left/)).not.toBeInTheDocument();
    await userEvent.setup().paste('😀');
    expect(screen.getByText('50 characters left')).toBeInTheDocument();
    await userEvent.setup().paste('b'.repeat(50));
    expect(screen.getByText('0 characters left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
    await userEvent.setup().paste('c');
    expect(screen.getByText('1 character too many')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });

  it('W02 AS-54: status, token-by-token plain text, cited sources only with heading path and page, question kept', async () => {
    const scripted = openStream();
    render(<AskPanel productId={PRODUCT} />);
    await ask('  ' + QUESTION + '  ');
    expect(await screen.findByText('Searching the product documents…')).toBeInTheDocument();
    expect(scripted.body).toEqual({ question: QUESTION });

    act(() => {
      scripted.push('sources', { mode: 'hybrid', items: [source(1), source(2, { title: 'Quick start', headingPath: 'Setup > Charging', page: 4 }), source(3, { title: 'Warranty' })] });
      scripted.push('text', { t: 'It lasts <b>40</b> hours.\n' });
    });
    expect(await within(answerRegion()).findByText(/It lasts/)).toHaveTextContent('It lasts <b>40</b> hours.');
    // Plain text: markup is shown as typed, line breaks are kept, nothing is a link.
    expect(answerRegion().querySelector('b')).toBeNull();
    expect(within(answerRegion()).getByText(/It lasts/)).toHaveClass('whitespace-pre-wrap');
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();

    act(() => {
      scripted.push('text', { t: 'See [2].' });
      scripted.push('done', { citations: [{ text: 'See [2].', sources: [2] }], grounded: true });
      scripted.end();
    });
    expect(await screen.findByText('Sources')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('[2] Quick start › Setup › Charging (page 4)');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(within(answerRegion()).getByText(/It lasts/).textContent).toBe('It lasts <b>40</b> hours.\nSee [2].');
    expect(status()).toHaveTextContent('Answer ready');
    expect(questionField()).toHaveValue(`  ${QUESTION}  `);
    expect(screen.queryByText('Searching the product documents…')).not.toBeInTheDocument();
  });

  it('W02 AS-54: a cited source without a page has no page part, and sources are numbered as the sources event numbers them', async () => {
    const run = answerWith([
      ['sources', { mode: 'keyword', items: [source(0), source(7, { headingPath: 'Care' })] }],
      ['text', { t: 'Yes.' }],
      ['done', { citations: [{ text: 'Yes.', sources: [7, 0] }], grounded: true }],
    ]);
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    act(() => run.play());
    const items = await screen.findAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['[0] Lantern manual › Battery', '[7] Lantern manual › Care']);
  });

  it('W02 AS-55: not_found shows our copy, not the server message, and no sources', async () => {
    const run = answerWith([
      ['sources', { mode: 'hybrid', items: [source(1)] }],
      ['not_found', { message: 'SERVER WORDS: ask the seller' }],
    ]);
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    act(() => run.play());
    expect(await within(answerRegion()).findByText("I couldn't find an answer in this product's documents. Try rephrasing your question.")).toBeInTheDocument();
    expect(screen.queryByText(/SERVER WORDS/)).not.toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent('No answer found');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('W02 AS-55: a refusal shows the copy without the category; text already received stays with the rest-can\'t-be-shown line', async () => {
    const scripted = openStream();
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    act(() => {
      scripted.push('sources', { mode: 'hybrid', items: [source(1)] });
      scripted.push('text', { t: 'The battery' });
      scripted.push('refusal', { category: 'general_harms', source: 'moderation' });
      scripted.end();
    });
    const region = answerRegion();
    expect(await within(region).findByText("I can't answer that question.")).toBeInTheDocument();
    expect(within(region).getByText('The battery')).toBeInTheDocument();
    expect(within(region).getByText("The rest of the answer can't be shown.")).toBeInTheDocument();
    expect(screen.queryByText(/general_harms|general harms/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  it('W02 AS-55: a refusal before any text has only the first line', async () => {
    const run = answerWith([['refusal', { category: 'violence', source: 'provider' }]]);
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    act(() => run.play());
    expect(await within(answerRegion()).findByText("I can't answer that question.")).toBeInTheDocument();
    expect(screen.queryByText("The rest of the answer can't be shown.")).not.toBeInTheDocument();
  });

  it('W02 AS-56: 404 replaces the tab content with the unavailable text', async () => {
    refuseWith(404, { code: 'not_found' });
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    expect(await screen.findByText("Questions aren't available for this product.")).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument();
  });

  it.each([
    ['422 input_rejected', 422, { code: 'input_rejected', category: 'sensitive_data' }, {}, "We can't answer that question. Try rephrasing it."],
    ['429 assistant_busy', 429, { code: 'assistant_busy' }, { 'retry-after': '30' }, 'The assistant is busy right now. Try again in 30 seconds.'],
    ['503 assistant_unavailable', 503, { code: 'assistant_unavailable' }, {}, 'The assistant is unavailable right now. Try again later.'],
    ['400 validation_failed', 400, { code: 'validation_failed' }, {}, 'Questions must be between 3 and 500 characters.'],
  ])('W02 AS-56: %s shows one alert and keeps the question', async (_name, statusCode, body, headers, text) => {
    refuseWith(statusCode, body, headers);
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(questionField()).toHaveValue(QUESTION);
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Answer' })).not.toBeInTheDocument();
  });

  it('W02 AS-56: 429 rate_limited names the wait and re-enables Ask when it has passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    refuseWith(429, { code: 'rate_limited' }, { 'retry-after': '90' });
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    expect(await screen.findByRole('alert')).toHaveTextContent("You've asked a lot of questions. Try again in 2 minutes.");
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    act(() => void vi.advanceTimersByTime(89_000));
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    act(() => void vi.advanceTimersByTime(1_500));
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });

  it('W02 AS-56: offline shows the offline copy', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    expect(await screen.findByRole('alert')).toHaveTextContent('You appear to be offline. Check your connection and try again.');
    expect(questionField()).toHaveValue(QUESTION);
  });

  it('W02 AS-56: another 5xx shows our text with the reference', async () => {
    refuseWith(500, { code: 'internal_error', requestId: 'req-abc-1', detail: 'stack trace here' });
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side. Try again.');
    expect(alert).toHaveTextContent('Reference: req-abc-1');
    expect(alert).not.toHaveTextContent('stack trace');
  });

  it.each(['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'INTERNAL'])(
    'W02 AS-57: the in-stream error %s keeps the text and shows the line with Ask again, not an alert',
    async (code) => {
      const scripted = openStream();
      render(<AskPanel productId={PRODUCT} />);
      await ask();
      act(() => {
        scripted.push('text', { t: 'Part of an answer' });
        scripted.push('error', { code });
        scripted.end();
      });
      const region = answerRegion();
      expect(await within(region).findByText("The answer couldn't be completed. Try again.")).toBeInTheDocument();
      expect(within(region).getByText('Part of an answer')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ask again' })).toBeEnabled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(status()).toHaveTextContent("The answer couldn't be completed. Try again.");
    },
  );

  it('W02 AS-57: a stream that ends without done is the same failure', async () => {
    const scripted = openStream();
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    act(() => {
      scripted.push('text', { t: 'Cut off' });
      scripted.end();
    });
    expect(await within(answerRegion()).findByText("The answer couldn't be completed. Try again.")).toBeInTheDocument();
    expect(within(answerRegion()).getByText('Cut off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeInTheDocument();
  });

  it('W02 AS-57: an event with invalid JSON ends the answer as a failure and keeps the text', async () => {
    const scripted = openStream();
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    act(() => {
      scripted.push('text', { t: 'Before' });
      scripted.raw('event: text\ndata: {oops\n\n');
    });
    expect(await within(answerRegion()).findByText("The answer couldn't be completed. Try again.")).toBeInTheDocument();
    expect(within(answerRegion()).getByText('Before')).toBeInTheDocument();
  });

  it('W02 AS-57: grounded false shows the notice and an empty Sources list', async () => {
    const run = answerWith([
      ['sources', { mode: 'hybrid', items: [source(1)] }],
      ['text', { t: 'Probably.' }],
      ['done', { citations: [{ text: 'Probably.', sources: [1] }], grounded: false }],
    ]);
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    act(() => run.play());
    expect(await screen.findByText("This answer isn't backed by the product documents. Check important details with the seller.")).toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(within(answerRegion()).getByText('Probably.')).toBeInTheDocument();
  });

  it('W02 AS-58: while an answer is written Ask is replaced by Stop; Stop aborts the request and keeps the text with "Stopped."', async () => {
    const scripted = openStream();
    render(<AskPanel productId={PRODUCT} />);
    const user = await ask();
    expect(screen.queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument();
    act(() => scripted.push('text', { t: 'Half an ans' }));
    expect(await within(answerRegion()).findByText('Half an ans')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(scripted.aborted).toBe(true);
    expect(await within(answerRegion()).findByText('Stopped.')).toBeInTheDocument();
    expect(within(answerRegion()).getByText('Half an ans')).toBeInTheDocument();
    expect(status()).toHaveTextContent('Stopped.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });

  it('W02 AS-58: leaving the page (unmount) aborts the request', async () => {
    const scripted = openStream();
    const { unmount } = render(<AskPanel productId={PRODUCT} />);
    await ask();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    unmount();
    expect(scripted.aborted).toBe(true);
  });

  it('W02 AS-58: a double press of Ask sends one request, and Enter while it runs sends none', async () => {
    openStream();
    render(<AskPanel productId={PRODUCT} />);
    const user = await type();
    const button = screen.getByRole('button', { name: 'Ask' });
    await user.dblClick(button);
    await user.type(questionField(), '{Enter}');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('W02 AS-58: asking again clears the previous answer, sources and notices first', async () => {
    const first = answerWith([
      ['sources', { mode: 'hybrid', items: [source(1)] }],
      ['text', { t: 'First answer' }],
      ['done', { citations: [{ text: 'First answer', sources: [1] }], grounded: false }],
    ]);
    render(<AskPanel productId={PRODUCT} />);
    const user = await ask();
    act(() => first.play());
    expect(await screen.findByText(/isn't backed by the product documents/)).toBeInTheDocument();

    const second = openStream();
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('First answer')).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't backed by the product documents/)).not.toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
    act(() => second.push('text', { t: 'Second' }));
    expect(await within(answerRegion()).findByText('Second')).toBeInTheDocument();
  });

  it('W02 AS-58: a panel kept mounted while its tab is hidden keeps streaming', async () => {
    const scripted = openStream();
    const { rerender } = render(<div><AskPanel productId={PRODUCT} /></div>);
    await ask();
    act(() => scripted.push('text', { t: 'one ' }));
    expect(await within(answerRegion()).findByText('one')).toBeInTheDocument();
    rerender(<div hidden><AskPanel productId={PRODUCT} /></div>);
    act(() => scripted.push('text', { t: 'two' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Answer', hidden: true })).toHaveTextContent('one two'));
    expect(scripted.aborted).toBe(false);
  });

  it('W02 AS-59: the answer is a region named Answer, aria-busy while writing, not a live region; a hidden polite status announces the state', async () => {
    const scripted = openStream();
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    const region = await screen.findByRole('region', { name: 'Answer' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).not.toHaveAttribute('aria-live');
    expect(region.querySelector('[aria-live], [role="status"], [role="alert"], [role="log"]')).toBeNull();
    const live = status();
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveClass('sr-only');
    expect(live).toHaveTextContent('Searching the product documents');
    act(() => scripted.push('text', { t: 'tok' }));
    await within(region).findByText('tok');
    // Tokens are not announced one by one: the status text did not change.
    expect(live).toHaveTextContent(/^Searching the product documents$/);
    act(() => {
      scripted.push('done', { citations: [], grounded: true });
      scripted.end();
    });
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'false'));
    expect(live).toHaveTextContent('Answer ready');
  });

  it('W02 AS-59: role alert is used only for request errors', async () => {
    const scripted = openStream();
    render(<AskPanel productId={PRODUCT} />);
    await ask();
    act(() => {
      scripted.push('error', { code: 'TIMEOUT' });
      scripted.end();
    });
    await screen.findByRole('button', { name: 'Ask again' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('W02 AS-77: no question or answer text reaches the console, the address or web storage', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const scripted = openStream();
    render(<AskPanel productId={PRODUCT} />);
    const before = window.location.href;
    await ask();
    act(() => {
      scripted.push('text', { t: 'Secret answer' });
      scripted.push('error', { code: 'INTERNAL' });
      scripted.end();
    });
    await screen.findByRole('button', { name: 'Ask again' });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain('lantern');
    expect(logged).not.toContain('Secret answer');
    expect(window.location.href).toBe(before);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('lantern');
  });
});
