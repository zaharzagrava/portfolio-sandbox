'use client';

import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ChatInterface } from './chat-interface';

export function AssistantSheet() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleToggle = () => setOpen((prev) => !prev);
    window.addEventListener('toggle-assistant', handleToggle);
    return () => window.removeEventListener('toggle-assistant', handleToggle);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
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
