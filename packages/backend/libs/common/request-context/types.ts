import { ClsStore } from 'nestjs-cls';

/**
 * Everything a request carries implicitly through the call graph. Set once at
 * the edge of the app (middleware/guards), read anywhere (repositories,
 * producers, loggers) without threading parameters through every function.
 */
export interface AppClsStore extends ClsStore {
  requestId: string;
  userId?: string;
  /** Tenant (SD-02). Only set after membership has been verified. */
  shopId?: string;
  roles?: string[];
  /** Admission / API-key / service identity, when not a user. */
  principalType?: 'user' | 'apiKey' | 'service' | 'anonymous';
}

export const REQUEST_ID_HEADER = 'x-request-id';
