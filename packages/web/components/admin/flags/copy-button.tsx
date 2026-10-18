'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type State = 'idle' | 'copied' | 'failed';
const COPIED_MS = 2000;

/**
 * A named button that copies `text` and says what happened in a polite status region (W06 AS-40, AS-51). A blocked clipboard
 * is reported with the manual way, never silently.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<State>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" aria-label={label} onClick={() => void copy()} className="min-h-11 sm:min-h-7">
        {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        <span aria-hidden="true">{state === 'copied' ? 'Copied' : 'Copy'}</span>
      </Button>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? "Couldn't copy. Select the text and press Ctrl+C (⌘C on Mac)." : ''}
      </span>
    </>
  );
}
