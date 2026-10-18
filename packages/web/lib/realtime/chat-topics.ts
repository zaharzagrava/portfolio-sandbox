import type { ChatInboxItem } from '@marketplace-sandbox/contracts';

/**
 * Which hub topics the chat page listens to (W05 FR-040, R-03). One connection holds at most 10 topics, together with the
 * member's own `user:<id>` (S51 FR-008), so: the open chat, and up to 8 other chats with the latest activity. Chats beyond the
 * cap rely on the inbox refresh (AS-10). The list is sorted so an unchanged set is an equal list, and a re-render never
 * reconnects.
 */
export const MAX_OTHER_TOPICS = 8;
export const chatTopic = (channelId: string): string => `chat:${channelId}`;

/** The channel id of a `chat:<id>` topic, or null for any other topic. */
export function channelOfTopic(topic: string): string | null {
  return topic.startsWith('chat:') ? topic.slice('chat:'.length) : null;
}

export function selectTopics(openId: string | null, items: Pick<ChatInboxItem, 'id' | 'lastMessageAt' | 'isArchived'>[]): string[] {
  const others = items
    .filter((item) => item.id !== openId && !item.isArchived)
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
    .slice(0, MAX_OTHER_TOPICS)
    .map((item) => chatTopic(item.id));
  return [...(openId ? [chatTopic(openId)] : []), ...others].sort();
}
