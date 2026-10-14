import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../vitest.setup';
import { AskProduct } from './ask-product';

const PRODUCT = '0192f7a0-0000-7000-8000-00000000c001';
const sse = (events: [string, unknown][]) =>
  new HttpResponse(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
const source = (n: number, over: Record<string, unknown> = {}) => ({
  n,
  chunkId: `c${n}`,
  documentId: `d${n}`,
  title: 'Pixel 10 manual',
  headingPath: 'Pixel 10 manual > Connectivity',
  page: null,
  ...over,
});
const problem = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  HttpResponse.json(body, { status, headers: { 'content-type': 'application/problem+json', ...headers } });

async function ask(response: () => Response | Promise<Response>, question = 'Does it support eSIM?') {
  server.use(http.post(`/api/products/${PRODUCT}/ask`, response));
  render(<AskProduct productId={PRODUCT} />);
  await userEvent.type(screen.getByLabelText('Question'), question);
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('S47 W02: ask this product', () => {
  it('S47 AS-01: shows the streamed answer with a chip per source (heading path and page)', async () => {
    await ask(() =>
      sse([
        ['sources', { mode: 'hybrid', items: [source(0), source(1, { title: 'Quick start', headingPath: 'Quick start > SIM', page: 4 })] }],
        ['text', { t: 'Yes - it supports ' }],
        ['text', { t: 'eSIM and dual SIM.' }],
        ['done', { citations: [{ text: 'Yes - it supports eSIM and dual SIM.', sources: [0] }], grounded: true }],
      ]),
    );
    expect(await screen.findByTestId('ask-answer')).toHaveTextContent('Yes - it supports eSIM and dual SIM.');
    const chips = screen.getAllByTestId('ask-source');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('Pixel 10 manual > Connectivity');
    expect(chips[1]).toHaveTextContent('Quick start > SIM');
    expect(chips[1]).toHaveTextContent('p. 4');
    expect(screen.queryByTestId('ask-hint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ask-message')).not.toBeInTheDocument();
  });

  it('S47 AS-12: an answer that cited nothing carries a hint that it is not tied to the documents', async () => {
    await ask(() =>
      sse([
        ['sources', { mode: 'keyword', items: [source(0)] }],
        ['text', { t: 'Probably.' }],
        ['done', { citations: [{ text: 'Probably.', sources: [] }], grounded: false }],
      ]),
    );
    expect(await screen.findByTestId('ask-hint')).toHaveTextContent(/documents/i);
    expect(screen.getByTestId('ask-answer')).toHaveTextContent('Probably.');
  });

  it('S47 AS-03: nothing found shows the not_found message and no chips', async () => {
    await ask(() =>
      sse([['not_found', { message: "I couldn't find this in the product documentation. Try asking the seller." }]]),
    );
    expect(await screen.findByTestId('ask-message')).toHaveTextContent('Try asking the seller');
    expect(screen.queryByTestId('ask-source')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ask-answer')).not.toBeInTheDocument();
  });

  it('S47 AS-10: a refusal is shown as a refusal, not as an error', async () => {
    await ask(() =>
      sse([
        ['sources', { mode: 'hybrid', items: [source(0)] }],
        ['refusal', { category: 'general_harms', source: 'provider' }],
      ]),
    );
    expect(await screen.findByTestId('ask-refusal')).toHaveTextContent(/cannot|can't/i);
    expect(screen.queryByTestId('ask-message')).not.toBeInTheDocument();
  });

  it.each([
    ['PROVIDER_UNAVAILABLE', /unavailable/i],
    ['TIMEOUT', /too long/i],
    ['INTERNAL', /went wrong/i],
  ])('S47 AS-09: the in-stream error %s keeps the text already shown and explains', async (code, expected) => {
    await ask(() =>
      sse([
        ['sources', { mode: 'hybrid', items: [source(0)] }],
        ['text', { t: 'Part of an answer' }],
        ['error', { code }],
      ]),
    );
    expect(await screen.findByTestId('ask-message')).toHaveTextContent(expected);
    expect(screen.getByTestId('ask-answer')).toHaveTextContent('Part of an answer');
  });

  it.each([
    ['401', 401, { code: 'invalid_token' }, {}, /sign in/i],
    ['404 not askable', 404, { code: 'not_found' }, {}, /not available/i],
    ['422 sensitive data', 422, { code: 'input_rejected', category: 'sensitive_data' }, {}, /card numbers or secrets/i],
    ['422 other category', 422, { code: 'input_rejected', category: 'violence' }, {}, /cannot be answered/i],
    ['422 cost exceeded', 422, { code: 'rate_limit_cost_exceeded' }, {}, /too large/i],
    ['429 rate limited', 429, { code: 'rate_limited' }, { 'retry-after': '12' }, /12 seconds/],
    ['429 busy', 429, { code: 'assistant_busy' }, { 'retry-after': '3' }, /busy.*3 seconds/i],
    ['503 unavailable', 503, { code: 'assistant_unavailable' }, { 'retry-after': '2' }, /unavailable/i],
    ['503 limiter down', 503, { code: 'rate_limiter_unavailable' }, { 'retry-after': '1' }, /unavailable/i],
    ['500 anything else', 500, { code: 'internal_error' }, {}, /could not ask/i],
  ])('S47 W02: HTTP %s → a specific message', async (_name, status, body, headers, expected) => {
    await ask(() => problem(status, body, headers));
    expect(await screen.findByTestId('ask-message')).toHaveTextContent(expected);
    expect(screen.queryByTestId('ask-answer')).not.toBeInTheDocument();
  });

  it('S47 AS-05: a question shorter than 3 characters cannot be sent', async () => {
    render(<AskProduct productId={PRODUCT} />);
    await userEvent.type(screen.getByLabelText('Question'), 'ab');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Question'), 'c');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled());
  });
});
