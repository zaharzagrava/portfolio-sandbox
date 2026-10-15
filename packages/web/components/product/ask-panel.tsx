'use client';

import { useEffect, useId, useReducer, useRef, useState, type FormEvent } from 'react';
import type { RagSource, RagStreamEvent } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { askProduct } from '@/lib/api/ask';
import { problemFromError, type Problem } from '@/lib/api/errors';

const MIN_LENGTH = 3;
const MAX_LENGTH = 500;
const COUNTER_FROM = 50;

const LINES = {
  searching: 'Searching the product documents…',
  notFound: "I couldn't find an answer in this product's documents. Try rephrasing your question.",
  refused: "I can't answer that question.",
  restHidden: "The rest of the answer can't be shown.",
  failed: "The answer couldn't be completed. Try again.",
  ungrounded: "This answer isn't backed by the product documents. Check important details with the seller.",
  stopped: 'Stopped.',
} as const;

type Phase = 'idle' | 'asking' | 'streaming' | 'answered' | 'not_found' | 'refused' | 'stopped' | 'failed' | 'blocked';

type State = {
  phase: Phase;
  text: string;
  /** Every source of the `sources` event, by `n`. */
  sources: RagSource[];
  /** The `n` of the sources the final answer cites (empty when it is not grounded). */
  cited: number[];
  grounded: boolean;
  /** A request refused before a stream opened; the answer area stays empty. */
  problem?: Problem;
  /** `429`: Ask stays off until this many milliseconds have passed. */
  waitMs: number;
  waiting: boolean;
};

type Action =
  | { type: 'start' }
  | { type: 'event'; event: RagStreamEvent }
  | { type: 'cut' }
  | { type: 'stop' }
  | { type: 'rejected'; problem: Problem }
  | { type: 'wait_over' };

const INITIAL: State = { phase: 'idle', text: '', sources: [], cited: [], grounded: true, waitMs: 0, waiting: false };

const isRunning = (phase: Phase) => phase === 'asking' || phase === 'streaming';

/** idle → asking → streaming → answered | not_found | refused | stopped | failed, plus blocked (the `404` tab replacement). */
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'start':
      // Asking again clears the previous answer, sources and notices first.
      return { ...INITIAL, phase: 'asking' };
    case 'event': {
      if (!isRunning(state.phase)) return state;
      const { event } = action;
      switch (event.event) {
        case 'sources':
          return { ...state, sources: event.items };
        case 'text':
          return { ...state, phase: 'streaming', text: state.text + event.t };
        case 'done':
          return {
            ...state,
            phase: 'answered',
            grounded: event.grounded,
            cited: event.grounded ? [...new Set(event.citations.flatMap((citation) => citation.sources))] : [],
          };
        case 'not_found':
          return { ...state, phase: 'not_found', text: '' };
        case 'refusal':
          return { ...state, phase: 'refused' };
        case 'error':
          return { ...state, phase: 'failed' };
      }
      return state;
    }
    case 'cut':
      return isRunning(state.phase) ? { ...state, phase: 'failed' } : state;
    case 'stop':
      return isRunning(state.phase) ? { ...state, phase: 'stopped' } : state;
    case 'rejected': {
      if (action.problem.status === 404) return { ...INITIAL, phase: 'blocked', problem: action.problem };
      const wait = action.problem.status === 429 ? (action.problem.retryAfterSeconds ?? 0) * 1000 : 0;
      return { ...INITIAL, phase: 'failed', problem: action.problem, waitMs: wait, waiting: wait > 0 };
    }
    case 'wait_over':
      return { ...state, waiting: false };
  }
}

const codePoints = (text: string) => Array.from(text).length;

function describeSource(source: RagSource): string {
  const path = source.headingPath
    .split(' > ')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' › ');
  return `[${source.n}] ${source.title}${path ? ` › ${path}` : ''}${source.page === null ? '' : ` (page ${source.page})`}`;
}

/** What the hidden polite status says for a state (tokens are never announced one by one). */
function announcement(state: State): string {
  switch (state.phase) {
    case 'asking':
    case 'streaming':
      return 'Searching the product documents';
    case 'answered':
      return 'Answer ready';
    case 'not_found':
      return 'No answer found';
    case 'refused':
      return LINES.refused;
    case 'stopped':
      return LINES.stopped;
    case 'failed':
      return state.problem ? '' : LINES.failed;
    default:
      return '';
  }
}

/**
 * The **Ask about this product** tab (W02 AS-54..AS-59): a question of 3 to 500 characters is sent through `lib/api/ask.ts`
 * and the answer, grounded in the seller's documents, is written as the `text` events arrive. The answer is plain text,
 * the sources are lines (documents have no public address), and the question never leaves the field, the component's state
 * or the request body: not the address, storage, analytics or the console (AS-77). One request runs at a time; **Stop**,
 * leaving the page (unmount) and asking again close the connection. A tab switch only hides the panel, so it keeps writing.
 */
export function AskPanel({ productId }: { productId: string }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [question, setQuestion] = useState('');
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);
  const ids = useId();

  // Leaving the page closes the connection.
  useEffect(() => () => controller.current?.abort(), []);

  // `429`: Ask comes back when the wait has passed.
  useEffect(() => {
    if (!state.waiting) return;
    const timer = setTimeout(() => dispatch({ type: 'wait_over' }), state.waitMs);
    return () => clearTimeout(timer);
  }, [state.waiting, state.waitMs]);

  const length = codePoints(question.trim());
  const valid = length >= MIN_LENGTH && length <= MAX_LENGTH;
  const typed = codePoints(question);
  const remaining = MAX_LENGTH - typed;

  async function start() {
    if (running.current || !valid || state.waiting) return;
    running.current = true;
    const own = new AbortController();
    controller.current = own;
    dispatch({ type: 'start' });
    let ended = false;
    try {
      await askProduct(productId, question, {
        signal: own.signal,
        onEvent: (event) => {
          if (event.event === 'done' || event.event === 'not_found' || event.event === 'refusal' || event.event === 'error') ended = true;
          if (!own.signal.aborted) dispatch({ type: 'event', event });
        },
      });
      if (!ended && !own.signal.aborted) dispatch({ type: 'cut' });
    } catch (error) {
      // Stop and leaving the page abort on purpose; they have their own outcome.
      if (!own.signal.aborted) dispatch({ type: 'rejected', problem: problemFromError(error) });
    } finally {
      running.current = false;
      if (controller.current === own) controller.current = null;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void start();
  }

  function stop() {
    controller.current?.abort();
    dispatch({ type: 'stop' });
  }

  const { phase, problem } = state;
  const working = isRunning(phase);
  const showAnswer = phase !== 'idle' && phase !== 'blocked' && !(phase === 'failed' && problem);
  const hasText = state.text.length > 0;
  const cited = state.sources.filter((source) => state.cited.includes(source.n)).sort((a, b) => a.n - b.n);

  if (phase === 'blocked' && problem) {
    return (
      <section aria-labelledby={`${ids}-title`} className="max-w-[45rem] space-y-4">
        <h2 id={`${ids}-title`} className="text-lg font-medium">
          Ask about this product
        </h2>
        <ProblemAlert problem={problem} surface="ask" />
      </section>
    );
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="max-w-[45rem] space-y-4">
      <h2 id={`${ids}-title`} className="text-lg font-medium">
        Ask about this product
      </h2>
      <p className="text-sm text-muted-foreground">Answers come from this product&apos;s documents.</p>

      <form onSubmit={submit} className="space-y-2">
        <label htmlFor={`${ids}-question`} className="block text-sm font-medium">
          Your question
        </label>
        <Input
          id={`${ids}-question`}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          autoComplete="off"
          aria-describedby={remaining <= COUNTER_FROM ? `${ids}-counter` : undefined}
          className="h-11 sm:h-9"
        />
        {remaining <= COUNTER_FROM ? (
          <p id={`${ids}-counter`} className="text-xs text-muted-foreground">
            {remaining >= 0 ? `${remaining} ${remaining === 1 ? 'character' : 'characters'} left` : `${-remaining} ${remaining === -1 ? 'character' : 'characters'} too many`}
          </p>
        ) : null}
        {working ? (
          <Button
            key="stop"
            type="button"
            variant="outline"
            className="min-h-11 max-sm:w-full"
            // The second press of a double press on Ask lands here once the button has changed; it is not a Stop.
            onClick={(event) => {
              if (event.detail > 1) return;
              stop();
            }}
          >
            Stop
          </Button>
        ) : (
          <Button key="ask" type="submit" className="min-h-11 max-sm:w-full" disabled={!valid || state.waiting}>
            {phase === 'failed' && !problem ? 'Ask again' : 'Ask'}
          </Button>
        )}
      </form>

      {problem ? <ProblemAlert problem={problem} surface="ask" /> : null}

      <p role="status" aria-live="polite" className="sr-only">
        {announcement(state)}
      </p>

      {showAnswer ? (
        <div role="region" aria-label="Answer" aria-busy={working} className="space-y-3 rounded-lg border p-4" data-testid="ask-region">
          {phase === 'asking' ? <p className="text-sm text-muted-foreground">{LINES.searching}</p> : null}
          {hasText ? (
            <p className="whitespace-pre-wrap break-words text-sm" data-testid="ask-answer">
              {state.text}
            </p>
          ) : null}
          {phase === 'not_found' ? <p className="text-sm">{LINES.notFound}</p> : null}
          {phase === 'refused' ? (
            <>
              <p className="text-sm">{LINES.refused}</p>
              {hasText ? <p className="text-sm text-muted-foreground">{LINES.restHidden}</p> : null}
            </>
          ) : null}
          {phase === 'stopped' ? <p className="text-sm text-muted-foreground">{LINES.stopped}</p> : null}
          {phase === 'failed' ? <p className="text-sm text-muted-foreground">{LINES.failed}</p> : null}
          {phase === 'answered' && !state.grounded ? <p className="text-sm text-muted-foreground">{LINES.ungrounded}</p> : null}
          {phase === 'answered' && cited.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium">Sources</h3>
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {cited.map((source) => (
                  <li key={source.n} data-testid="ask-source">
                    {describeSource(source)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
