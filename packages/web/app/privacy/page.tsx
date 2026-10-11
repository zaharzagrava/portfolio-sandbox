import { browserStorageKeys } from '@/lib/browser-storage-keys';

export const metadata = { title: 'Privacy Policy | Marketplace' };

const STORE_LABEL = { cookie: 'Cookie', localStorage: 'Local storage', sessionStorage: 'Session storage (this tab only)' } as const;

export default function PrivacyPage() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-10 prose prose-slate">
      <h1>Privacy Policy</h1>
      <p>We store the email address and password hash you register with, your session data, and the content you create (carts, orders, discussions).</p>
      <p>Session cookies are HttpOnly and used only for authentication and CSRF protection. Data is not shared with third parties.</p>
      <h2>What this site keeps in your browser</h2>
      <ul>
        {browserStorageKeys.map((entry) => (
          <li key={entry.key}>
            <code>{entry.key}</code> ({STORE_LABEL[entry.store]}): {entry.purpose}
          </li>
        ))}
      </ul>
    </div>
  );
}
