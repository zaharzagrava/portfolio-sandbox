'use client';

import { List, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SheetClose, SheetDescription, SheetHeader as Header, SheetTitle } from '@/components/ui/sheet';

/**
 * Title, description and the header controls (W05 AS-65, AS-66). Tab order: **Chats**, **New chat**, close, then the content.
 * The close button is rendered here (not by the sheet primitive) so it sits before the transcript and the field in that order.
 */
export function SheetHeader({
  member,
  listOpen,
  canStartNew,
  onToggleList,
  onNewChat,
}: {
  member: boolean;
  listOpen: boolean;
  canStartNew: boolean;
  onToggleList: () => void;
  onNewChat: () => void;
}) {
  return (
    <Header className="flex-row items-center gap-2 border-b p-3 pr-3">
      <div className="min-w-0 flex-1">
        <SheetTitle>AI Shopping Assistant</SheetTitle>
        <SheetDescription>Ask about products, prices and pickup points.</SheetDescription>
      </div>
      {member && (
        <>
          <Button type="button" variant={listOpen ? 'secondary' : 'ghost'} className="min-h-11 min-w-11" aria-pressed={listOpen} onClick={onToggleList}>
            <List aria-hidden="true" className="h-4 w-4" />
            <span className="max-sm:sr-only">Chats</span>
          </Button>
          <Button type="button" variant="ghost" className="min-h-11 min-w-11" disabled={!canStartNew} onClick={onNewChat}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            <span className="max-sm:sr-only">New chat</span>
          </Button>
        </>
      )}
      <SheetClose asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Close" className="min-h-11 min-w-11">
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      </SheetClose>
    </Header>
  );
}
