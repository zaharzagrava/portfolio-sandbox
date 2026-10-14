'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SECURITY_TABS, parseTab, type SecurityTab } from './tab-ids';
import { useDesktop } from './use-desktop';

export { parseTab };

/**
 * Account security tabs (W01 FR-051). A vertical list at >= 1024 px (Up/Down arrows), a horizontal scrollable strip below
 * (Left/Right); Home and End work in both. Only the selected panel is mounted, so only it is in the accessibility tree. The
 * selected tab is mirrored into `?tab=` with `history.replaceState` (other parameters stay) and is the page's view state.
 */
export function SecurityTabs({ initialTab, panels }: { initialTab: SecurityTab; panels: Record<SecurityTab, ReactNode> }) {
  const [tab, setTab] = useState<SecurityTab>(initialTab);
  const desktop = useDesktop();
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  function select(next: string) {
    const id = parseTab(next);
    setTab(id);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', id);
    window.history.replaceState(window.history.state, '', url);
  }

  return (
    <Tabs value={tab} onValueChange={select} orientation={desktop ? 'vertical' : 'horizontal'} className="flex-col gap-6 lg:flex-row lg:gap-8">
      <TabsList
        ref={list}
        variant="line"
        aria-label="Account security sections"
        className="h-auto w-full justify-start overflow-x-auto border-b p-0 lg:w-[220px] lg:shrink-0 lg:self-start lg:overflow-visible lg:border-b-0"
      >
        {SECURITY_TABS.map(({ id, label }) => (
          <TabsTrigger key={id} value={id} className="h-11 min-h-11 flex-none px-3 lg:h-9 lg:min-h-0">
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {SECURITY_TABS.map(({ id }) => (
        <TabsContent key={id} value={id} className="min-w-0 flex-1 focus-visible:ring-0">
          {panels[id]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
