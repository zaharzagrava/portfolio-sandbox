/** The correlation ids every log line about a turn carries; a line never carries content (S46 AS-57). */
export interface LogIds {
  requestId?: string;
  conversationId: string;
  messageId: string;
  /** The model call the line is about (`<messageId>:<n>`), when there is one. */
  callId?: string;
}

export const logIds = (ids: LogIds): string =>
  `requestId=${ids.requestId ?? '-'} conversationId=${ids.conversationId} messageId=${ids.messageId}${ids.callId ? ` callId=${ids.callId}` : ''}`;
