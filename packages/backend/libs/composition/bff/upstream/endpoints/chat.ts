import {
  chatUnreadPageSchema,
  type ChatUnreadPage,
} from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/** S24 `GET /api/chat/unread`: signed-in only; the page is forwarded with its `nextCursor`, never summed. */
export const chatUnread = (): Endpoint<ChatUnreadPage> => ({
  name: 'chat_unread',
  upstream: 'chat',
  method: 'GET',
  path: '/api/chat/unread',
  schema: chatUnreadPageSchema,
  identity: 'required',
  sharedCache: false,
  breaker: true,
});
