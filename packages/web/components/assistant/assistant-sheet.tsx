'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ChatInterface } from './chat-interface';

/** The assistant panel. Opened and closed by its launcher (`components/chat/assistant-launcher.tsx`). */
export function AssistantSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col h-full border-l">
        <SheetHeader className="p-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            AI Shopping Assistant
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-hidden relative">
          <ChatInterface />
        </div>
      </SheetContent>
    </Sheet>
  );
}
