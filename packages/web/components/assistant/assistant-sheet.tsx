'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState, type RefObject } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import type { AssistantChat } from '@/hooks/use-assistant-chat';
import { loginHref } from '@/lib/auth/return-to';
import { ChatInterface } from './chat-interface';
import { ConversationList } from './conversation-list';
import { SheetHeader } from './sheet-header';

/** The address to come back to after signing in: the current path and query (`returnTo` of W01). */
function currentAddress(pathname: string | null): string {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  return `${pathname ?? '/'}${search}`;
}

function SignedOut({ pathname }: { pathname: string | null }) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center text-muted-foreground">
      <p>Sign in to chat with the shopping assistant.</p>
      <Link href={loginHref(currentAddress(pathname))} data-autofocus className="inline-flex min-h-11 items-center rounded-md px-3 font-medium text-foreground underline underline-offset-2">
        Sign in
      </Link>
    </div>
  );
}

function SheetBody({ chat }: { chat: AssistantChat }) {
  const { status } = useAuth();
  const pathname = usePathname();
  const [listOpen, setListOpen] = useState(false);
  const member = status === 'authenticated';

  return (
    <>
      <SheetHeader
        member={member}
        listOpen={listOpen}
        canStartNew={chat.canStartNew}
        onToggleList={() => setListOpen((open) => !open)}
        onNewChat={() => {
          chat.newChat();
          setListOpen(false);
        }}
      />
      {status === 'loading' && (
        <div role="status" aria-label="Checking your session" className="flex flex-1 flex-col gap-3 p-4">
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="ml-auto h-10 w-1/2" />
        </div>
      )}
      {status === 'anonymous' && <SignedOut pathname={pathname} />}
      {status === 'unavailable' && <p className="p-6 text-center text-muted-foreground">We can&apos;t check your session right now. Try again in a moment.</p>}
      {member && (listOpen ? <ConversationList chat={chat} onChosen={() => setListOpen(false)} /> : <ChatInterface chat={chat} />)}
    </>
  );
}

/**
 * The assistant panel (W05 AS-41, AS-65, AS-66): a modal dialog, full screen on a phone (dynamic viewport height, so the on-screen
 * keyboard never covers the composer) and a 28 rem panel on the right from 1024 px. Opened and closed by its launcher, which also
 * owns the conversation state so closing the sheet does not stop a reply. Focus goes to the message field (or **Sign in**).
 */
export function AssistantSheet({
  open,
  onOpenChange,
  chat,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chat: AssistantChat;
  /** The launcher button: focus goes back to it when the sheet closes. */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={content}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusTo?.current?.focus();
        }}
        className="gap-0 p-0 data-[side=right]:h-dvh data-[side=right]:w-full data-[side=right]:sm:max-w-md motion-reduce:transition-none motion-reduce:animate-none"
      >
        <SheetBody chat={chat} />
      </SheetContent>
    </Sheet>
  );
}
