'use client';

import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { COPIED_MS } from './secret-reveal-dialog';

type State = 'idle' | 'copied' | 'failed';

/**
 * A named button that copies `text` and says what happened in a polite status region (W04 AS-72, AS-89). A blocked
 * clipboard is reported with the manual way, never silently. Not for secrets: those use `RevealSecretDialog`.
 */
export function CopyButton({ text, label, showLabel = false }: { text: string; label: string; showLabel?: boolean }) {
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
      <Button type="button" variant="outline" size={showLabel ? 'sm' : 'icon-sm'} aria-label={label} onClick={() => void copy()} className="min-h-11 sm:min-h-0">
        {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        {showLabel && <span aria-hidden="true">{state === 'copied' ? 'Copied' : 'Copy'}</span>}
      </Button>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? "Couldn't copy. Select the text and press Ctrl+C (⌘C on Mac)." : ''}
      </span>
    </>
  );
}
