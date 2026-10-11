import { clearRefreshCookie, relay } from '@/lib/api/auth-relay';

export async function POST(request: Request) {
  const response = await relay(request, '/api/auth/logout');
  await clearRefreshCookie(request);
  return response;
}
