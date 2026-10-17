'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** The "Copied" label stays this long (W04 AS-47). */
export const COPIED_MS = 2_000;

type CopyState = 'idle' | 'copied' | 'denied';

/**
 * Shows an API key or a webhook signing secret once (W04 AS-46, AS-47, FR-032). The secret lives only in the `secret` prop
 * of the caller's state and in this dialog's DOM: it is not written to the query cache, the URL, any storage, the console
 * or analytics. The dialog cannot be dismissed by accident: Escape and a click outside do nothing; "Done" before a copy asks
 * once ("Close anyway" or "Copy key"). `secret === null` means closed.
 */
export function RevealSecretDialog({
  title,
  description,
  secret,
  note,
  onDone,
}: {
  title: string;
  description: string;
  secret: string | null;
  note?: string;
  onDone: () => void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={secret !== null}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={() => {
          // There is no DialogTrigger here, so the control that opened the dialog is remembered by hand (AS-94).
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
        }}
        className="sm:max-w-lg"
      >
        {secret !== null && <Body title={title} description={description} secret={secret} note={note} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ title, description, secret, note, onDone }: { title: string; description: string; secret: string; note?: string; onDone: () => void }) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const [hasCopied, setHasCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = setTimeout(() => setCopy('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copy]);

  function selectSecret() {
    const element = codeRef.current;
    const selection = window.getSelection();
    if (!element || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopy('copied');
      setHasCopied(true);
      setConfirming(false);
    } catch {
      setCopy('denied');
      selectSecret();
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <code
        ref={codeRef}
        tabIndex={0}
        aria-label="Secret"
        onCopy={() => setHasCopied(true)}
        className="block rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all"
      >
        {secret}
      </code>
      {note && <p className="text-sm">{note}</p>}
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {copy === 'copied' ? 'Copied to clipboard' : copy === 'denied' ? 'Press Ctrl+C (⌘C on Mac) to copy.' : ''}
      </p>
      {confirming && (
        <div role="alert" className="grid gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <p>You haven&apos;t copied this key. It can&apos;t be shown again.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onDone}>
              Close anyway
            </Button>
            <Button type="button" size="sm" autoFocus onClick={() => void copySecret()}>
              Copy key
            </Button>
          </div>
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => void copySecret()}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" onClick={() => (hasCopied ? onDone() : setConfirming(true))}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
