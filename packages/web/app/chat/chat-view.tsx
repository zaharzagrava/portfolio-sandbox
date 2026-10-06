'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { apiClient } from '@/lib/api/client';
import { chatApi, mergeMessages, type ChatChannel, type ChatMessage } from '@/lib/api/chat';
import { apiErrorMessage } from '@/lib/api/errors';

const POLL_MS = 3_000;

/** `?product=<id>`: open that product's chat - join it as a buyer, or create it when you are its seller. */
async function openProductChat(productId: string, userId: string): Promise<ChatChannel> {
  try {
    const channel = await chatApi.byProduct(productId);
    return channel.myRole ? channel : await chatApi.join(channel.id);
  } catch (error) {
    if ((error as { response?: { status?: number } }).response?.status !== 404) throw error;
    const { data: product } = await apiClient.get<{ sellerId: string }>(`/api/products/${productId}`);
    if (product.sellerId !== userId) throw new Error('The seller has not opened a chat for this product yet.');
    return chatApi.create(productId);
  }
}

export function ChatView() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const productId = params.get('product');

  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const cursors = useRef<Record<string, number>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login?returnUrl=%2Fchat');
  }, [authLoading, user, router]);

  // Channel list (+ the product's chat when opened from a product page).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const opened = productId ? await openProductChat(productId, user.id) : null;
        const mine = await chatApi.myChannels();
        const list = await Promise.all(mine.map((c) => chatApi.channel(c.channelId)));
        if (cancelled) return;
        if (opened && !list.some((c) => c.id === opened.id)) list.unshift(opened);
        setChannels(list);
        setUnread(Object.fromEntries(mine.map((c) => [c.channelId, c.unread])));
        for (const c of list) cursors.current[c.id] ??= 0;
        setActive((current) => current ?? opened?.id ?? list[0]?.id ?? null);
      } catch (error) {
        toast.error(apiErrorMessage(error, (error as Error).message || 'Could not open the chat.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, productId]);

  // Catch up from the per-channel cursors; polled while the page is open.
  const sync = useCallback(async () => {
    if (Object.keys(cursors.current).length === 0) return;
    const result = await chatApi.sync(cursors.current);
    for (const c of result) {
      if (!c.messages.length) continue;
      cursors.current[c.channelId] = Math.max(cursors.current[c.channelId] ?? 0, ...c.messages.map((m) => m.seq));
      setMessages((prev) => ({ ...prev, [c.channelId]: mergeMessages(prev[c.channelId] ?? [], c.messages) }));
    }
  }, []);

  useEffect(() => {
    if (!channels.length) return;
    void sync().catch(() => undefined);
    const timer = setInterval(() => void sync().catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [channels, sync]);

  const activeMessages = (active && messages[active]) || [];
  const lastSeq = activeMessages.at(-1)?.seq;

  // Read receipt for what is on screen.
  useEffect(() => {
    if (!active || !lastSeq) return;
    void chatApi.markRead(active, lastSeq).catch(() => undefined);
    setUnread((u) => ({ ...u, [active]: 0 }));
  }, [active, lastSeq]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMessages.length]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!active || !text.trim()) return;
    setSending(true);
    try {
      const { message } = await chatApi.send(active, text.trim());
      setMessages((prev) => ({ ...prev, [active]: mergeMessages(prev[active] ?? [], [message]) }));
      cursors.current[active] = Math.max(cursors.current[active] ?? 0, message.seq);
      setText('');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Message not sent.'));
    } finally {
      setSending(false);
    }
  };

  if (authLoading || !user) return <div className="container mx-auto py-10 px-4 text-muted-foreground">Loading chat…</div>;

  const activeChannel = channels.find((c) => c.id === active);
  const authorLabel = (authorId: string) => (authorId === user.id ? 'You' : authorId === activeChannel?.sellerId ? 'Seller' : `Buyer ${authorId.slice(0, 4)}`);

  return (
    <div className="container mx-auto py-6 px-4 h-[calc(100vh-4rem)] flex gap-4">
      <aside className="w-72 shrink-0 border rounded-lg flex flex-col">
        <div className="p-4 border-b font-semibold">Product chats</div>
        <div className="flex-1 overflow-y-auto">
          {channels.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No chats yet. Open a product and press <em>Chat with seller</em>.
            </p>
          )}
          {channels.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActive(c.id)}
              className={`w-full text-left p-4 border-b hover:bg-muted/50 ${active === c.id ? 'bg-muted' : ''}`}
              data-testid="chat-channel"
            >
              <div className="flex justify-between gap-2">
                <span className="font-medium truncate">{c.title}</span>
                {!!unread[c.id] && <Badge>{unread[c.id]}</Badge>}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex-1 border rounded-lg flex flex-col min-w-0">
        {activeChannel ? (
          <>
            <div className="p-4 border-b flex justify-between items-center">
              <span className="font-semibold" data-testid="chat-title">{activeChannel.title}</span>
              <Link href={`/products/${activeChannel.productId}`} className="text-sm underline">
                View product
              </Link>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {activeMessages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet. Say hello!</p>}
              {activeMessages.map((m) => (
                <div key={m.id} className={`flex ${m.authorId === user.id ? 'justify-end' : 'justify-start'}`} data-testid="chat-message">
                  <div className={`max-w-[70%] rounded-lg px-3 py-2 ${m.authorId === user.id ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                    <div className="text-xs opacity-70 mb-1">{authorLabel(m.authorId)}</div>
                    <div className="text-sm whitespace-pre-wrap">{m.deleted ? <em>message removed</em> : m.body}</div>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <form onSubmit={send} className="p-4 border-t flex gap-2">
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" maxLength={4000} aria-label="Message" />
              <Button type="submit" disabled={sending || !text.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">Select a chat</div>
        )}
      </section>
    </div>
  );
}
