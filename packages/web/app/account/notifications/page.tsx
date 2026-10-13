import type { Metadata } from 'next';
import { PreferencesScreen } from '@/components/notifications/preferences-screen';

export const metadata: Metadata = { title: 'Notifications' };

/** Guarded by `app/account/layout.tsx`. `/settings/notifications` (the link in notifications) redirects here (next.config.ts). */
export default function NotificationSettingsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
      <PreferencesScreen />
    </div>
  );
}
