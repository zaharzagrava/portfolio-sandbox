/**
 * Liveness probe for the load balancer (W07 AS-41): the web process is up. No backend call, no session, not a document
 * (so no nonce policy: `proxy.ts` leaves `/health` out).
 */
export async function GET(): Promise<Response> {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
