'use client';

import { Bell } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * The navbar's bell (W03 AS-61): named "Notifications, {n} unread" (or "Notifications"), with a badge that reads `99+`
 * above 99 and is absent at 0 or while the count is unknown. It spreads its props so it can be a popover trigger.
 */
export function BellButton({ unread, ...props }: { unread: number | null } & Omit<ComponentProps<typeof Button>, 'children' | 'aria-label'>) {
  const count = unread ?? 0;
  return (
    <Button {...props} variant="ghost" size="icon" className="relative min-h-11 min-w-11 lg:min-h-9 lg:min-w-9" aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}>
      <Bell aria-hidden="true" className="h-5 w-5" />
      {count > 0 && (
        <Badge variant="destructive" aria-hidden="true" className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full p-0 px-1 text-xs">
          {count > 99 ? '99+' : count}
        </Badge>
      )}
    </Button>
  );
}
