import { Suspense } from 'react';
import { MemberGuard } from './member-guard';

/** The session is read inside the Suspense boundary, never at the top of the layout (W01 FR-005, AS-62). */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<p className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</p>}>
      <MemberGuard>{children}</MemberGuard>
    </Suspense>
  );
}
