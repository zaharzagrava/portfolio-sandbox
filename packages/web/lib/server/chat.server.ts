import 'server-only';
import { chatInboxPageSchema, type ChatInboxPage } from '@marketplace-sandbox/contracts';
import { readAsMember } from '@/lib/server/member-read.server';
import type { ReadResult } from '@/lib/server/read.server';

const FIRST_PAGE = 50;

/**
 * Server prefetch of the first inbox page (`GET /api/chat/channels/mine` through the BFF forwarder) as the signed-in member
 * (W05 FR-010, AS-69). A failure comes back as a value; the page then leaves the cache empty and the browser reads again and
 * shows its own state, so no member data and no error text is cached on the server. Never call it inside `"use cache"`.
 */
export async function getInboxPage(): Promise<ReadResult<ChatInboxPage>> {
  return readAsMember(`/api/bff/f/chat/channels/mine?limit=${FIRST_PAGE}`, chatInboxPageSchema);
}
