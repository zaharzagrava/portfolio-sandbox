import type { Flag } from '@marketplace-sandbox/contracts';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const STATUS_LABEL: Record<Flag['status'], string> = { enabled: 'Enabled', disabled: 'Disabled', killed: 'Killed', archived: 'Archived' };

const TONE: Record<Flag['status'], string> = {
  enabled: 'border-green-600/40 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-100',
  disabled: 'border-border bg-muted text-foreground',
  killed: 'border-red-600/40 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100',
  archived: 'border-border bg-muted text-foreground italic',
};

/** The state of a flag in words, never by colour alone (W06 AS-01). Reads `status`, not the derived `enabled`. */
export function StatusBadge({ status, className }: { status: Flag['status']; className?: string }) {
  return (
    <Badge variant="outline" className={cn(TONE[status], className)}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
