import { requireServerSession } from '@/lib/auth/session.server';

/** Member-only guard for everything under `/account` (W01 F1/F2): anonymous visitors go to `/login?returnTo=…`. Convenience only (VI.5). */
export async function MemberGuard({ children }: { children: React.ReactNode }) {
  await requireServerSession('/account/security');
  return <>{children}</>;
}
