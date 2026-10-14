import { LegalPage, type LegalPageSection } from '@/components/legal/legal-page';
import { browserStorageKeys } from '@/lib/browser-storage-keys';

// The title is completed by the root layout's template: "Privacy policy · Marketplace" (AS-26).
export const metadata = { title: 'Privacy policy' };

/** Changed in the same pull request as any change of the text or of `lib/browser-storage-keys.ts` (FR-030, FR-053). */
const LAST_UPDATED = '2026-10-14';

const STORE_LABEL = { cookie: 'Cookie', localStorage: 'Local storage', sessionStorage: 'Session storage (this tab only)' } as const;

const sections: LegalPageSection[] = [
  {
    id: 'what-we-store',
    title: 'What we store',
    body: (
      <>
        <p>
          When you register we store your email address and your password hash (never the password itself). We keep your sessions, with the device
          and the network address they were opened from, so that you can see them and sign them out.
        </p>
        <p>
          We also store what you create: carts, orders, shops and products if you sell, and the content you post, such as discussions, chat messages,
          photos and videos.
        </p>
      </>
    ),
  },
  {
    id: 'cookies-and-browser-storage',
    title: 'Cookies and browser storage',
    body: (
      <>
        <p>
          The session cookie is HttpOnly and used only to keep you signed in. The CSRF cookie is readable by the page, not a credential: it
          only protects against forged requests. The anonymous visitor id is first party, lasts one year and is used only for the marketplace&apos;s
          own analytics; it is not set when your browser sends Global Privacy Control or Do Not Track. Your theme choice is kept in local storage.
          There are no advertising or third-party tracking cookies.
        </p>
        <p>Everything this site keeps in your browser:</p>
        <ul>
          {browserStorageKeys.map((entry) => (
            <li key={entry.key}>
              <code>{entry.key}</code> ({STORE_LABEL[entry.store]}): {entry.purpose}
            </li>
          ))}
        </ul>
      </>
    ),
  },
  {
    id: 'who-receives-data',
    title: 'Who receives data',
    body: (
      <p>
        The payment provider in the sandbox receives the details of a test payment, and the map tile host receives the area of the map you look at
        when a map is configured. Nobody else receives your data, and there is no sale of data.
      </p>
    ),
  },
  {
    id: 'your-choices',
    title: 'Your choices',
    body: (
      <>
        <p>You can sign out on all devices from your account security page.</p>
        <p>Accounts and content in this showcase may be deleted at any time; ask via the address below.</p>
      </>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: <p>Questions about this policy can be sent to the project maintainers through the source-code repository linked in the footer.</p>,
  },
];

export default function PrivacyPage() {
  return <LegalPage title="Privacy policy" updated={LAST_UPDATED} sections={sections} />;
}
