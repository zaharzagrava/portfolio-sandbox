'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AssistantChat } from '@/hooks/use-assistant-chat';
import { useBrowserLocation } from '@/hooks/use-browser-location';
import { Composer } from './composer';
import { LocationSwitch } from './location-switch';
import { ReplyNotice } from './reply-notice';
import { Transcript } from './transcript';
import { UsageMeter } from './usage-meter';

const LOCATION_FAILED = ['denied', 'unsupported', 'timeout', 'unavailable'];

/**
 * The member's view of the conversation: transcript, inline notice, composer with the location switch, allowance line. All
 * state comes from `useAssistantChat` (owned by the launcher so a running reply survives closing the sheet); the only state kept
 * here is the location switch and the position it holds, in memory, gone when the sheet closes (W05 AS-46).
 */
export function ChatInterface({ chat }: { chat: AssistantChat }) {
  const location = useBrowserLocation();
  const [wanted, setWanted] = useState(false);
  const failed = wanted && LOCATION_FAILED.includes(location.status);
  const on = wanted && !failed;

  const toggle = (next: boolean) => {
    setWanted(next);
    if (next) location.request();
  };

  const send = () => chat.send(on && location.coords ? { lat: location.coords.lat, lng: location.coords.lng } : {});

  let empty;
  if (chat.conversationId !== null && chat.historyState === 'loading') {
    empty = (
      <p role="status" className="my-8 text-center text-sm text-muted-foreground">
        Loading the conversation…
      </p>
    );
  } else if (chat.conversationId !== null && chat.historyState === 'error') {
    empty = (
      <div role="alert" className="my-8 flex flex-col items-center gap-2 text-center text-sm">
        <p>We couldn&apos;t load this conversation.</p>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void chat.refetchHistory()}>
          Try again
        </Button>
      </div>
    );
  } else if (chat.conversationId === null) {
    empty = (
      <div className="my-8 text-center text-muted-foreground">
        <p>Hi! I&apos;m your AI Shopping Assistant.</p>
        <p className="mt-2 text-sm">How can I help you today?</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <Transcript items={chat.items} busy={chat.running} announce={chat.announce} empty={empty} />
      {chat.notice && <ReplyNotice notice={chat.notice} onTryAgain={chat.notice.tryAgain === 'reattach' ? chat.reattach : chat.tryAgain} onNewChat={chat.newChat} />}
      <Composer
        value={chat.input}
        onChange={chat.setInput}
        onSend={send}
        canSend={chat.canSend}
        running={chat.running}
        stopping={chat.reply.phase === 'stopping'}
        canStop={chat.reply.messageId !== undefined}
        onStop={chat.stop}
        lock={chat.lock}
        onNewChat={chat.newChat}
        switcher={<LocationSwitch checked={on} failed={failed} onCheckedChange={toggle} />}
      />
      <UsageMeter usage={chat.usage} />
    </div>
  );
}
