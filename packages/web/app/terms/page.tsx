import { LegalPage, type LegalPageSection } from '@/components/legal/legal-page';

// The title is completed by the root layout's template: "Terms of service · Marketplace" (AS-26).
export const metadata = { title: 'Terms of service' };

/** Changed in the same pull request as any change of the text (FR-030). */
const LAST_UPDATED = '2026-10-11';

const sections: LegalPageSection[] = [
  { id: 'what-this-is', title: 'What this is', body: <p>Marketplace is a portfolio project demonstrating system-design patterns. No real goods are sold and no real payments are taken.</p> },
  { id: 'accounts', title: 'Accounts', body: <p>You are responsible for your credentials. Accounts, orders and content may be deleted at any time.</p> },
  { id: 'acceptable-use', title: 'Acceptable use', body: <p>Do not abuse the service, scrape it at harmful rates, or probe other people&apos;s data. Rate limits apply.</p> },
  { id: 'the-api', title: 'The API', body: <p>Sellers&apos; API keys are personal and must be used within their scopes.</p> },
  { id: 'no-warranty', title: 'No warranty', body: <p>The service is provided as is, without warranty of any kind.</p> },
  { id: 'changes', title: 'Changes', body: <p>These terms may change; the date above shows the latest revision.</p> },
  { id: 'contact', title: 'Contact', body: <p>Questions about these terms can be sent to the project maintainers through the source-code repository linked in the footer.</p> },
];

export default function TermsPage() {
  return <LegalPage title="Terms of service" updated={LAST_UPDATED} sections={sections} />;
}
