/** Close codes of the editing connection (S06 contracts/collab-ws.md). W04 reconnects according to this table. */
export const CLOSE = {
  roomClosed: { code: 1001, reason: 'room_closed' },
  frameTooLarge: { code: 1009, reason: 'frame_too_large' },
  serviceRestart: { code: 1012, reason: 'service_restart' },
  protocolError: { code: 4000, reason: 'protocol_error' },
  /** The reason of this close is the address of the owner. */
  wrongInstance: { code: 4001, reason: '' },
  roomMoved: { code: 4002, reason: 'room_moved' },
  accessRevoked: { code: 4003, reason: 'access_revoked' },
  shopInactive: { code: 4003, reason: 'shop_inactive' },
  draftNotFound: { code: 4004, reason: 'draft_not_found' },
  draftClosed: { code: 4005, reason: 'draft_closed' },
  roomFull: { code: 4008, reason: 'room_full' },
  tooManyConnections: { code: 4008, reason: 'too_many_connections' },
  documentTooLarge: { code: 4009, reason: 'document_too_large' },
  storeUnavailable: { code: 4013, reason: 'store_unavailable' },
  rateLimited: { code: 4029, reason: 'rate_limited' },
} as const;

export type CloseReason = (typeof CLOSE)[keyof typeof CLOSE];

/** Label for the closes-by-code metric (bounded set). */
export const closeLabel = (code: number): string => `${code}`;

/** Message type byte the server sends to the sender of a denied write (payload: varstring reason). */
export const MESSAGE_PERMISSION_DENIED = 4;
