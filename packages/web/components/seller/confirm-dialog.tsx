'use client';

import { useRef, useState, type ReactNode } from 'react';
import { currentOpener } from '@/lib/focus-opener';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * The accessible replacement for `window.confirm` (W04 FR-047, AS-94): focus starts on Cancel, Escape closes, Tab stays
 * inside, focus returns to the control that opened it. While `onConfirm` runs, both buttons are disabled and further
 * presses are ignored, so a double press sends one request. A rejected `onConfirm` leaves the dialog open (the caller shows
 * the problem through `error`).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  confirmClassName,
  error,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Extra classes of the confirm button (W06 uses a solid red that meets the contrast rule). */
  confirmClassName?: string;
  /** A problem alert from the last attempt. */
  error?: ReactNode;
  /** Extra controls between the description and the buttons (an overlap choice, for instance). */
  children?: ReactNode;
  onConfirm: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  async function confirm() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      await onConfirm();
    } catch {
      /* the caller shows the problem in `error`; the dialog stays open for another try */
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          // There is no DialogTrigger here, so the control that opened the dialog is remembered by hand.
          opener.current = currentOpener();
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {error}
        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={destructive ? 'destructive' : 'default'} className={confirmClassName} disabled={pending} aria-busy={pending} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
