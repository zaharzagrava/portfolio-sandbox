'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Light / Dark / System. The choice is the only thing the shell stores in the browser (`localStorage`, not a credential). */
export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  // The saved choice is only known in the browser: show the default until mounted so server and client markup agree.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-lg" className="size-11 lg:size-9" aria-label="Theme">
          <Sun aria-hidden="true" className="h-5 w-5 scale-100 dark:scale-0 motion-safe:transition-transform" />
          <Moon aria-hidden="true" className="absolute h-5 w-5 scale-0 dark:scale-100 motion-safe:transition-transform" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={mounted ? (theme ?? 'system') : 'system'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
