import 'server-only';
import { unsubscribeDescribeSchema } from '@marketplace-sandbox/contracts';
import { apiUrl } from '@/lib/server/endpoints.server';
import { readPublic, type ReadResult } from '@/lib/server/read.server';

/**
 * `GET /api/notifications/unsubscribe?token=` (S28 FR-036): says which category the link switches off and changes nothing
 * (mail scanners open every link). Anonymous, never cached, and the token goes only into this request.
 */
export async function describeUnsubscribe(token: string): Promise<ReadResult<{ category: string }>> {
  return readPublic(`${apiUrl()}/api/notifications/unsubscribe?${new URLSearchParams({ token }).toString()}`, unsubscribeDescribeSchema);
}
