import Link from 'next/link';
import { UNAVAILABLE_CHAT_TEXT } from '@/lib/chat/errors-copy';
import { chatHref } from '@/lib/chat/links';

/** `403`/`404`/`revoked` on a chat: nothing from a cache is shown for it (W05 FR-015, AS-27, AS-40). */
export function UnavailableChat() {
  return (
    <div className="flex h-full flex-col items-start gap-3 p-6" role="alert">
      <p className="text-base font-medium">{UNAVAILABLE_CHAT_TEXT}</p>
      <Link href={chatHref({})} className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium underline underline-offset-4 hover:bg-accent">
        Back to all chats
      </Link>
    </div>
  );
}
