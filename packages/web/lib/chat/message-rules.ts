import type { ChatMessage } from '@marketplace-sandbox/contracts';

export type MyRole = 'OWNER' | 'MODERATOR' | 'MEMBER' | null;

/** Who is offered **Delete** (W05 AS-20): the author of the message, or the chat's owner or a moderator. The server decides again. */
export function canDeleteMessage(message: Pick<ChatMessage, 'authorId' | 'deleted'>, selfId: string | null, myRole: MyRole): boolean {
  if (message.deleted) return false;
  return message.authorId === selfId || myRole === 'OWNER' || myRole === 'MODERATOR';
}

/** The first `max` code points of a text, with an ellipsis when it was cut (the reply chip and the quoted preview). */
export function preview(text: string, max = 80): string {
  const points = [...text.replace(/\s+/g, ' ').trim()];
  return points.length <= max ? points.join('') : `${points.slice(0, max).join('')}…`;
}
