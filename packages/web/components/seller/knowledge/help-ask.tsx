'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RagSource } from '@marketplace-sandbox/contracts';
import { ProblemPanel } from '@/components/seller/problem-states';
import { FieldError } from '@/components/seller/developers/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { askStream } from '@/lib/api/ask';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { askPath } from '@/lib/api/seller-knowledge';

const MIN_LENGTH = 3;
const MAX_LENGTH = 500;

type Phase = 'idle' | 'asking' | 'answered' | 'not_found' | 'refused' | 'failed';
const LINES = {
  not_found: "I couldn't find an answer in your documents. Try rephrasing your question.",
  refused: "I can't answer that question.",
  failed: "The answer couldn't be completed. Try again.",
} as const;

/**
 * "Ask the help center" (S47 `POST …/knowledge/ask`, `shop.read`, allowed in a suspended shop): a question over the shop's
 * own documents. The answer streams in; the sources it used are listed. Nothing about cost or model is ever shown.
 */
export function HelpAsk({ shopId }: { shopId: string }) {
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [sources, setSources] = useState<RagSource[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [tooShort, setTooShort] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (phase === 'asking') return;
    if (question.trim().length < MIN_LENGTH) return setTooShort(true);
    setTooShort(false);
    controller.current?.abort();
    const ours = new AbortController();
    controller.current = ours;
    setPhase('asking');
    setText('');
    setSources([]);
    setProblem(null);
    let ended = false;
    try {
      await askStream(askPath(shopId), question, {
        signal: ours.signal,
        onEvent: (item) => {
          switch (item.event) {
            case 'sources':
              setSources(item.items);
              break;
            case 'text':
              setText((current) => current + item.t);
              break;
            case 'done':
              ended = true;
              setPhase('answered');
              break;
            case 'not_found':
              ended = true;
              setPhase('not_found');
              break;
            case 'refusal':
              ended = true;
              setPhase('refused');
              break;
            case 'error':
              ended = true;
              setPhase('failed');
              break;
          }
        },
      });
      if (!ended) setPhase('failed');
    } catch (error) {
      if (ours.signal.aborted) return;
      setProblem(problemFromError(error));
      setPhase('idle');
    }
  }

  return (
    <section aria-labelledby="help-ask-heading" className="space-y-3 rounded-lg border p-4">
      <h2 id="help-ask-heading" className="text-lg font-semibold">
        Ask the help center
      </h2>
      <p className="text-sm text-muted-foreground">Get an answer from your own documents.</p>
      <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2" noValidate>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <Label htmlFor="help-question">Your question</Label>
          <Input id="help-question" value={question} maxLength={MAX_LENGTH} autoComplete="off" aria-invalid={tooShort ? true : undefined} aria-describedby={tooShort ? 'help-question-error' : undefined} onChange={(event) => setQuestion(event.target.value)} />
        </div>
        <Button type="submit" className="min-h-11 sm:min-h-8" disabled={phase === 'asking'} aria-busy={phase === 'asking'}>
          Ask
        </Button>
      </form>
      <FieldError id="help-question-error">{tooShort ? `Ask with at least ${MIN_LENGTH} characters.` : undefined}</FieldError>

      {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} subject="requests" />}
      <div aria-live="polite" className="space-y-2">
        {phase === 'asking' && !text && <p className="text-sm text-muted-foreground">Searching your documents…</p>}
        {text && <p className="whitespace-pre-wrap">{text}</p>}
        {(phase === 'not_found' || phase === 'refused' || phase === 'failed') && <p className="text-sm">{LINES[phase]}</p>}
        {sources.length > 0 && phase !== 'not_found' && (
          <div className="text-sm">
            <p className="font-medium">Sources</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {sources.map((source) => (
                <li key={source.chunkId}>
                  {source.title}
                  {source.headingPath ? ` (${source.headingPath})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
