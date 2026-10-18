'use client';

import { LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The save bar, docked at the bottom of the content at both widths (W06 AS-18, AS-25, AS-61): "Unsaved changes" while the draft
 * differs from what was loaded, "Saved." (a polite status) after a save, **Discard** and **Save changes**, both disabled when
 * there is nothing to save. `blockedReason` explains a disabled Save that is not about being clean (a conflict, a killed flag).
 */
export function SaveBar({
  dirty,
  saving,
  saved,
  canSave,
  blockedReason,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  canSave: boolean;
  blockedReason?: string;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
      <div role="status" className="min-w-0 flex-1 text-sm">
        {saving ? 'Saving…' : dirty ? 'Unsaved changes' : saved ? 'Saved.' : ''}
      </div>
      {blockedReason && dirty && (
        <p id="save-blocked" className="w-full text-sm text-muted-foreground sm:w-auto">
          {blockedReason}
        </p>
      )}
      <Button type="button" variant="outline" disabled={!dirty || saving} onClick={onDiscard} className="min-h-11 flex-1 sm:min-h-8 sm:flex-none">
        Discard
      </Button>
      <Button type="button" disabled={!canSave} aria-busy={saving} aria-describedby={blockedReason && dirty ? 'save-blocked' : undefined} onClick={onSave} className="min-h-11 flex-1 sm:min-h-8 sm:flex-none">
        {saving && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
        Save changes
      </Button>
    </div>
  );
}
