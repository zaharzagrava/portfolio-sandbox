import type { ChatBanner } from '@/hooks/use-chat-live';

/** The honest state of the live connection, at the top of the inbox and conversation (W05 AS-24, AS-29). A polite status region; text, never colour alone. */
export function ConnectionBanner({ banner }: { banner: ChatBanner }) {
  return (
    <div role="status" className={banner ? 'shrink-0 border-b bg-muted px-4 py-2 text-sm' : 'sr-only'}>
      {banner === 'reconnecting' && 'Reconnecting…'}
      {banner === 'offline' && "You're offline. Messages will send when you're back online."}
    </div>
  );
}
