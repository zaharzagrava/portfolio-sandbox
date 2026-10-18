'use client';

import { useId } from 'react';
import { Switch } from '@/components/ui/switch';

export const LOCATION_UNAVAILABLE = 'Location unavailable. Allow location access in your browser to use this.';

/**
 * "Use my location" (W05 AS-46): off by default. The browser is asked once per switch-on (the owner of this switch calls
 * `useBrowserLocation().request()`); a denied or failed lookup turns the switch off and says so here.
 */
export function LocationSwitch({ checked, failed, onCheckedChange }: { checked: boolean; failed: boolean; onCheckedChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-center gap-2">
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
        <label htmlFor={id} className="text-xs text-muted-foreground">
          Use my location
        </label>
      </div>
      {failed && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {LOCATION_UNAVAILABLE}
        </p>
      )}
    </div>
  );
}
