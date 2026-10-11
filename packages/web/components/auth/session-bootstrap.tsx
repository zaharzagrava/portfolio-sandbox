import { AuthBootstrap } from '@/hooks/use-auth';
import { getServerSession } from '@/lib/auth/session.server';

/** Server Component: hands the session the server already read to the client query cache (render it under `<Suspense>`). */
export async function SessionBootstrap() {
  const user = await getServerSession();
  return <AuthBootstrap user={user} />;
}
