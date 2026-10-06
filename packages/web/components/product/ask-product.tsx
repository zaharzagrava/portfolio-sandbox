'use client';

import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { streamSse } from '@/lib/api/sse-reader';

type Status = 'idle' | 'asking' | 'answered' | 'not_found' | 'error';

/**
 * "Ask this product" (SD-43): POST /api/products/:id/ask streams `sources` → `text`… → `done` | `not_found`.
 * Answers come only from the shop's product documents; nothing retrieved means "not found", never a guess.
 */
export function AskProduct({ productId }: { productId: string }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  const ask = async () => {
    if (question.trim().length < 3) return;
    setStatus('asking');
    setAnswer('');
    setMessage('');
    try {
      const res = await streamSse(`/api/products/${productId}/ask`, { body: { question: question.trim() } }, (e) => {
        const data = JSON.parse(e.data || '{}');
        if (e.event === 'text') setAnswer((a) => a + data.t);
        else if (e.event === 'done') setStatus('answered');
        else if (e.event === 'not_found') {
          setStatus('not_found');
          setMessage(data.message);
        } else if (e.event === 'error' || e.event === 'refusal') {
          setStatus('error');
          setMessage('The assistant is unavailable right now. Please try again later.');
        }
      });
      if (!res.ok) {
        setStatus('error');
        setMessage(res.status === 429 ? 'Too many questions - wait a minute.' : 'Could not ask right now.');
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
      {message && <p className="text-sm text-muted-foreground mt-3" data-testid="ask-message">{message}</p>}
    </div>
  );
}
