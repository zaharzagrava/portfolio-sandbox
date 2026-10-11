import { relay } from '@/lib/api/auth-relay';

export const POST = (request: Request) => relay(request, '/api/auth/mfa/verify');
