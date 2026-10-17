'use client';

import { MoreHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type RowMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Not offered at all (a permission the member lacks, a state that makes the action meaningless). */
  hidden?: boolean;
};

/**
 * The action menu at the end of a table row or card (W04 AS-94). The trigger is named after its row ("Actions for {label}"),
 * opens with Enter or Space, items move with the arrow keys, Escape closes it and returns focus to the trigger. With no
 * visible item nothing is rendered (a viewer has no action menu). With `disabledReason` (a suspended shop) every item is
 * disabled and the reason is shown at the top of the menu. A chosen item runs after the menu has closed, so a dialog it
 * opens remembers the trigger as the control to return to.
 */
export function RowMenu({ label, items, disabledReason }: { label: string; items: RowMenuItem[]; disabledReason?: string | null }) {
  const visible = items.filter((item) => !item.hidden);
  if (visible.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${label}`} className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8">
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-44">
        {disabledReason && (
          <>
            <DropdownMenuLabel className="max-w-64 text-xs font-normal whitespace-normal text-muted-foreground">{disabledReason}</DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        {visible.map((item) => (
          <DropdownMenuItem
            key={item.id}
            variant={item.destructive ? 'destructive' : 'default'}
            disabled={item.disabled || Boolean(disabledReason)}
            onSelect={() => {
              setTimeout(item.onSelect, 0);
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
