import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Shown above the composer when the reader is up in the history and others have written since: pressing it shows them (W05 AS-32). */
export function JumpPill({ count, onJump }: { count: number; onJump: () => void }) {
  const noun = count === 1 ? 'message' : 'messages';
  return (
    <Button
      type="button"
      size="sm"
      className="absolute bottom-3 left-1/2 min-h-11 -translate-x-1/2 rounded-full shadow-md sm:min-h-8"
      aria-label={`Jump to latest, ${count} new ${noun}`}
      onClick={onJump}
    >
      {count} new {noun}
      <ArrowDown aria-hidden="true" />
    </Button>
  );
}
