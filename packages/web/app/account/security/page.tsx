import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Security' };

/** Guarded by `app/account/layout.tsx`. T071 (US8) adds the tabs and the two-step panel. */
export default function SecurityPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
    </div>
  );
}
