'use client';

import { PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState, type Dispatch } from 'react';
import { Button } from '@/components/ui/button';
import type { Draft, DraftAction } from '@/lib/admin/flags/draft';
import { RuleCard } from './rule-card';

/**
 * The ordered targeting rules (W06 AS-21): checked top to bottom, the first match wins. Every pointer action has a keyboard
 * path; after a move the new position is announced politely and focus stays on the pressed button (which moves with its rule).
 */
export function RulesEditor({ draft, dispatch, issues = {}, readOnly = false }: { draft: Draft; dispatch: Dispatch<DraftAction>; issues?: Record<string, string>; readOnly?: boolean }) {
  const [announcement, setAnnouncement] = useState('');
  const moved = useRef<{ uid: string; move: 'up' | 'down' } | null>(null);
  const variants = draft.variants.map((variant) => variant.key);

  function move(uid: string, direction: -1 | 1) {
    const from = draft.rules.findIndex((rule) => rule.uid === uid);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= draft.rules.length) return;
    moved.current = { uid, move: direction === -1 ? 'up' : 'down' };
    setAnnouncement(`Rule ${draft.rules[from]!.id} moved to position ${to + 1}`);
    dispatch({ type: 'moveRule', uid, direction });
  }

  // Re-focus the pressed button after the reorder (a moved node can lose focus).
  useEffect(() => {
    if (!moved.current) return;
    const { uid, move: which } = moved.current;
    moved.current = null;
    document.querySelector<HTMLElement>(`[data-rule-uid="${uid}"][data-move="${which}"]`)?.focus();
  }, [draft.rules]);

  return (
    <section id="flag-rules" aria-labelledby="rules-heading" className="space-y-3">
      <h2 id="rules-heading" className="text-base font-semibold">
        Targeting rules
      </h2>
      {draft.rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rules. Everyone gets the default variant.</p>
      ) : (
        <ol aria-label="Targeting rules, checked top to bottom; the first match wins" className="space-y-3">
          {draft.rules.map((rule, index) => (
            <li key={rule.uid}>
              <RuleCard rule={rule} index={index} count={draft.rules.length} variants={variants} dispatch={dispatch} issues={issues} readOnly={readOnly} onMove={move} />
            </li>
          ))}
        </ol>
      )}
      <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={readOnly} onClick={() => dispatch({ type: 'addRule' })}>
        <PlusIcon aria-hidden="true" />
        Add rule
      </Button>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
