'use client';

// Stand-in for the W05 contract: the owner replaces the body, never the name or props.

import { useSyncExternalStore } from 'react';
import { Sparkles } from 'lucide-react';
import { AssistantSheet } from '@/components/assistant/assistant-sheet';
import { Button } from '@/components/ui/button';

// One open/closed flag shared by both variants: the menu item lives in the mobile sheet, which unmounts when it closes,
// so the panel itself is owned by the `icon` variant that stays mounted in the header.
let open = false;
const listeners = new Set<() => void>();
const setOpen = (value: boolean) => {
  open = value;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const useOpen = () => useSyncExternalStore(subscribe, () => open, () => false);

export function AssistantLauncher({ variant }: { variant: 'icon' | 'menu-item' }) {
  const isOpen = useOpen();

  if (variant === 'menu-item') {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
      >
        <Sparkles aria-hidden="true" className="h-4 w-4 text-indigo-500" />
        AI Assistant
      </button>
    );
  }

  return (
    <>
      <Button variant="ghost" size="icon-lg" aria-label="AI Assistant" title="AI Assistant" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden="true" className="h-5 w-5 text-indigo-500" />
      </Button>
      <AssistantSheet open={isOpen} onOpenChange={setOpen} />
    </>
  );
}
