'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAT_FRAME } from '@/components/chat/chat-skeleton';
import { ChatNotice } from '@/components/chat/chat-notice';
import { ConnectionBanner } from '@/components/chat/connection-banner';
import { Conversation, type ConversationEntry } from '@/components/chat/conversation';
import { Inbox } from '@/components/chat/inbox';
import { ProductChatResolver } from '@/components/chat/product-chat-resolver';
import { UnavailableChat } from '@/components/chat/unavailable-chat';
import { useAuth } from '@/hooks/use-auth';
import { useChatLive } from '@/hooks/use-chat-live';
import { useInbox } from '@/hooks/use-inbox';
import { chatTargetFrom } from '@/lib/chat/links';
import { searchHref } from '@/lib/routes';

/**
 * The `/chat` screen (W05 AS-37, AS-38, AS-68): the inbox beside the open conversation from 1024 px, one pane at a time below
 * (`?channel=` shows the conversation, nothing shows the inbox). Which chat is open is the address and nothing else. Drafts are
 * a `Map` in this component's state: memory only, kept while the member looks at other chats, gone with the page. Focus: the
 * message field after Chat with seller, the heading when a chat is opened from the inbox, and the chat's row when the member
 * goes back to the list.
 */
export function ChatShell() {
  const target = chatTargetFrom(useSearchParams());
  const channelId = target.kind === 'channel' ? target.channelId : null;

  const [drafts] = useState(() => new Map<string, string>());
  const [rows] = useState(() => new Map<string, HTMLAnchorElement>());
  const registerRow = useCallback(
    (id: string, element: HTMLAnchorElement | null) => {
      if (element) rows.set(id, element);
      else rows.delete(id);
    },
    [rows],
  );

  // How the member got here decides where focus goes (AS-01, AS-38).
  const [initialChannel] = useState(channelId);
  const [resolvedChannel, setResolvedChannel] = useState<string | null>(null);
  const entry: ConversationEntry = channelId && resolvedChannel === channelId ? 'composer' : channelId && channelId !== initialChannel ? 'heading' : 'none';

  // Back to the list returns focus to the row that was open.
  const [lastChannel, setLastChannel] = useState(channelId);
  if (channelId && channelId !== lastChannel) setLastChannel(channelId);
  const returned = useRef<string | null>(null);
  useEffect(() => {
    if (channelId !== null || !lastChannel || returned.current === lastChannel) return;
    returned.current = lastChannel;
    rows.get(lastChannel)?.focus();
  }, [channelId, lastChannel, rows]);

  // The live connection, the catch-up and the banner (W05 FR-040, FR-041): one for the whole page.
  const { items } = useInbox();
  // The session ended (W01 sends the visitor to sign-in): drafts and "Not sent" bubbles hold nothing worth keeping, the live
  // connection is released, and nothing of the chats stays on screen (AS-40).
  const signedOut = useAuth().status === 'anonymous';
  const { banner } = useChatLive({ openId: signedOut ? null : channelId, items: signedOut ? [] : items });
  useEffect(() => {
    if (signedOut) drafts.clear();
  }, [signedOut, drafts]);

  const showConversation = target.kind !== 'none';

  if (signedOut) return null;

  return (
    <div className={CHAT_FRAME}>
      <ConnectionBanner banner={banner} />
      <div className="flex min-h-0 flex-1">
      <div className={`${showConversation ? 'hidden lg:flex' : 'flex'} min-h-0 w-full flex-col lg:w-80 lg:shrink-0 lg:border-r`}>
        <h2 className="border-b px-3 py-3 text-base font-semibold">Chats</h2>
        <Inbox openId={channelId} registerRow={registerRow} />
      </div>
      <div className={`${showConversation ? 'flex' : 'hidden lg:flex'} min-h-0 min-w-0 flex-1 flex-col`}>
        {target.kind !== 'channel' && <h1 className="sr-only">Your chats</h1>}
        {target.kind === 'none' && <p className="p-6 text-sm text-muted-foreground">Select a chat to read it.</p>}
        {target.kind === 'channel' && <Conversation key={target.channelId} channelId={target.channelId} drafts={drafts} entry={entry} />}
        {target.kind === 'invalid-channel' && <UnavailableChat />}
        {target.kind === 'product' && <ProductChatResolver key={target.productId} productId={target.productId} onResolved={setResolvedChannel} />}
        {target.kind === 'invalid-product' && (
          <div className="p-6">
            <ChatNotice text="This product link isn't valid.">
              <Link href={searchHref()} className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent sm:min-h-8">
                Browse products
              </Link>
            </ChatNotice>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
