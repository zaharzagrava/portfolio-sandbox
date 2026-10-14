'use client';

import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { ragStreamEventSchema, type RagSource } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { streamSse } from '@/lib/api/sse-reader';

type Status = 'idle' | 'asking' | 'answered' | 'not_found' | 'refused' | 'error';

interface Problem {
  code?: string;
  category?: string;
}

/** What the buyer is told for a request the server refused before any stream (S47 contracts/knowledge-api.md). */
export function describeAskFailure(status: number, problem: Problem | null, retryAfterSeconds: number | null): string {
  const wait = retryAfterSeconds && retryAfterSeconds > 0 ? ` ${Math.ceil(retryAfterSeconds)} seconds` : ' a minute';
  switch (status) {
    case 400:
      return 'Please write a question of 3 to 500 characters.';
    case 401:
      return 'Please sign in again to ask a question.';
    case 404:
      return 'Questions are not available for this product.';
    case 422:
      if (problem?.code === 'input_rejected')
        return problem.category === 'sensitive_data'
          ? 'Please remove card numbers or secrets from your question.'
          : 'This question cannot be answered.';
      if (problem?.code === 'rate_limit_cost_exceeded') return 'This question is too large.';
      return 'This question cannot be answered.';
    case 429:
      return problem?.code === 'assistant_busy'
        ? `The assistant is busy - try again in${wait}.`
        : `Too many questions - wait${wait}.`;
    case 503:
      return 'The assistant is unavailable right now. Please try again shortly.';
    default:
      return 'Could not ask right now.';
  }
}

const STREAM_ERRORS = {
  PROVIDER_UNAVAILABLE: 'The assistant is unavailable right now. Please try again later.',
  TIMEOUT: 'The answer took too long. Please try again.',
  INTERNAL: 'Something went wrong. Please try again.',
} as const;

/**
 * "Ask this product" (S47, W02): POST /api/products/:id/ask streams `sources` → `text`… → `done` | `not_found` |
 * `refusal` | `error`. Answers come only from the shop's product documents; nothing retrieved means "not found", never a
 * guess. Events are parsed with the shared contract schema; every refusal before the stream is a problem+json answered
 * with a message for its status.
 */
export function AskProduct({ productId }: { productId: string }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<RagSource[]>([]);
  const [grounded, setGrounded] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  const ask = async () => {
    if (question.trim().length < 3) return;
    setStatus('asking');
    setAnswer('');
    setSources([]);
    setGrounded(true);
    setMessage('');
    try {
      const res = await streamSse(`/api/products/${productId}/ask`, { body: { question: question.trim() } }, (e) => {
        let data: unknown;
        try {
          data = JSON.parse(e.data || '{}');
        } catch {
          return;
        }
        const parsed = ragStreamEventSchema.safeParse({ event: e.event, ...(data as object) });
        if (!parsed.success) return;
        const event = parsed.data;
        switch (event.event) {
          case 'sources':
            setSources(event.items);
            break;
          case 'text':
            setAnswer((a) => a + event.t);
            break;
          case 'done':
            setGrounded(event.grounded);
            setStatus('answered');
            break;
          case 'not_found':
            setStatus('not_found');
            setMessage(event.message);
            break;
          case 'refusal':
            setStatus('refused');
            break;
          case 'error':
            setStatus('error');
            setMessage(STREAM_ERRORS[event.code]);
            break;
        }
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => null)) as Problem | null;
        const retryAfter = Number(res.headers.get('retry-after'));
        setStatus('error');
        setMessage(describeAskFailure(res.status, problem, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null));
      }
    } catch {
      setStatus('error');
      setMessage('Could not ask right now.');
    }
  };

  return (
    <div className="mt-8 p-4 border rounded-lg bg-muted/30" data-testid="ask-product">
      <h3 className="font-medium flex items-center gap-2 mb-2">
        <MessageSquare className="w-4 h-4" /> Ask about this product
      </h3>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Is it waterproof?" className="bg-background" maxLength={500} aria-label="Question" />
        <Button type="submit" variant="secondary" disabled={status === 'asking' || question.trim().length < 3}>
          {status === 'asking' ? 'Asking…' : 'Ask'}
        </Button>
      </form>
      {answer && <p className="text-sm mt-3 whitespace-pre-wrap" data-testid="ask-answer">{answer}</p>}
      {status === 'answered' && !grounded && (
        <p className="text-xs text-muted-foreground mt-2" data-testid="ask-hint">
          This answer is not tied to the product documents - check it with the seller.
        </p>
      )}
      {sources.length > 0 && (
        <ul className="flex flex-wrap gap-2 mt-3" aria-label="Sources" data-testid="ask-sources">
          {sources.map((s) => (
            <li key={s.chunkId} className="text-xs rounded-full border bg-background px-2 py-1" data-testid="ask-source">
              {s.headingPath}
              {s.page ? ` · p. ${s.page}` : ''}
            </li>
          ))}
        </ul>
      )}
      {status === 'refused' && (
        <p className="text-sm text-muted-foreground mt-3" data-testid="ask-refusal">
          The assistant cannot help with this question.
        </p>
      )}
      {message && <p className="text-sm text-muted-foreground mt-3" data-testid="ask-message">{message}</p>}
    </div>
  );
}
