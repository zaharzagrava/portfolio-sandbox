'use client';

import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { useAssistantChat } from '@/hooks/use-assistant-chat';
import { clearAssistantStorage, loadSheetOpen, saveSheetOpen } from '@/lib/assistant/active-store';
import { subscribeAuth } from '@/lib/auth/session-sync';
import { AssistantSheet } from './assistant-sheet';

// One open/closed flag shared by both variants: the menu item lives in the mobile menu, which unmounts when it closes, so the
// panel and the conversation are owned by the `icon` variant that stays mounted in the header. The flag is also kept for the tab
// (`assistant.sheetOpen`) so a reload reopens the panel (AS-50); this is the whole "store": a boolean, not session data.
let open = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => open;

export function setAssistantSheetOpen(next: boolean): void {
  open = next;
  saveSheetOpen(next);
  listeners.forEach((listener) => listener());
}

const useSheetOpen = () => useSyncExternalStore(subscribe, snapshot, () => false);

function IconLauncher() {
  const isOpen = useSheetOpen();
  const chat = useAssistantChat({ active: isOpen });
  const trigger = useRef<HTMLButtonElement>(null);

  // A reload reopens a panel that was open (AS-50). It waits for the page to be hydrated: a modal that opened first would mark
  // page content as hidden before React has attached to it.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (loadSheetOpen()) setAssistantSheetOpen(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Signing out here or in another tab closes the panel; the conversation hook forgets the rest (AS-55).
  useEffect(
    () =>
      subscribeAuth((type) => {
        if (type !== 'signed-out') return;
        clearAssistantStorage();
        setAssistantSheetOpen(false);
      }),
    [],
  );

  return (
    <>
      <Button ref={trigger} variant="ghost" size="icon-lg" aria-label="AI Assistant" title="AI Assistant" data-running={chat.running} className="relative" onClick={() => setAssistantSheetOpen(true)}>
        <Sparkles aria-hidden="true" className="h-5 w-5 text-indigo-500" />
        {chat.running && <span aria-hidden="true" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-green-500 motion-safe:animate-pulse" />}
      </Button>
      <AssistantSheet open={isOpen} onOpenChange={setAssistantSheetOpen} chat={chat} returnFocusTo={trigger} />
    </>
  );
}

/** `icon`: the header button, which owns the sheet. `menu-item`: the entry in the mobile menu, which opens that sheet. */
export function AssistantLauncher({ variant }: { variant: 'icon' | 'menu-item' }) {
  if (variant === 'icon') return <IconLauncher />;
  return (
    <button type="button" onClick={() => setAssistantSheetOpen(true)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-accent">
      <Sparkles aria-hidden="true" className="h-4 w-4 text-indigo-500" />
      AI Assistant
    </button>
  );
}
