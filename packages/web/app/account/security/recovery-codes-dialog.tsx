'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SHEET_DIALOG } from './dialog-styles';

/**
 * The ten recovery codes, shown once (W01 AS-47). The codes are props of the caller's state and are written nowhere else:
 * not the query cache, storage or URL. The dialog cannot be dismissed until the member says they saved the codes, and
 * leaving the page meanwhile triggers the browser's own prompt.
 */
export function RecoveryCodesDialog({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast.success('Recovery codes copied.');
    } catch {
      toast.error("We couldn't copy the codes. Select them and copy by hand.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  const keep = (event: Event) => event.preventDefault();

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        className={SHEET_DIALOG}
        onEscapeKeyDown={saved ? undefined : keep}
        onPointerDownOutside={saved ? undefined : keep}
        onInteractOutside={saved ? undefined : keep}
      >
        <DialogHeader>
          <DialogTitle>Save your recovery codes</DialogTitle>
          <DialogDescription>Store these somewhere safe. You won&apos;t see them again.</DialogDescription>
        </DialogHeader>
        <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm">
          {codes.map((code) => (
            <li key={code} className="select-all">
              {code}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={() => void copyAll()}>
            Copy all
          </Button>
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={download}>
            Download .txt
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Checkbox id="codes-saved" checked={saved} onCheckedChange={(checked) => setSaved(checked === true)} />
          <Label htmlFor="codes-saved" className="text-sm font-normal">
            I&apos;ve saved these codes
          </Label>
        </div>
        <DialogFooter>
          <Button type="button" className="min-h-11 sm:min-h-0" disabled={!saved} onClick={onDone}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
