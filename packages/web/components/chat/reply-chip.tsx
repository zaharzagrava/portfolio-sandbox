import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Above the composer while a reply is being written (W05 AS-21): who is quoted, the start of the text, and a way to drop it. */
export function ReplyChip({ author, preview, onCancel }: { author: string; preview: string; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border-l-4 border-primary bg-muted px-3 py-1.5 text-sm">
      <p className="min-w-0 flex-1 truncate">
        Replying to {author}: {preview}
      </p>
      <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label="Cancel reply" onClick={onCancel}>
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
