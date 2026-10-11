export const metadata = { title: 'Terms of service' };

const LAST_UPDATED = '2026-10-11';

const sections = [
  { id: 'what-this-is', title: 'What this is', body: 'Marketplace is a portfolio project demonstrating system-design patterns. No real goods are sold and no real payments are taken.' },
  { id: 'accounts', title: 'Accounts', body: 'You are responsible for your credentials. Accounts, orders and content may be deleted at any time.' },
  { id: 'acceptable-use', title: 'Acceptable use', body: "Do not abuse the service, scrape it at harmful rates, or probe other people's data. Rate limits apply." },
  { id: 'the-api', title: 'The API', body: "Sellers' API keys are personal and must be used within their scopes." },
  { id: 'no-warranty', title: 'No warranty', body: 'The service is provided as is, without warranty of any kind.' },
  { id: 'changes', title: 'Changes', body: 'These terms may change; the date above shows the latest revision.' },
  { id: 'contact', title: 'Contact', body: 'Questions about these terms can be sent to the project maintainers through the source-code repository linked in the footer.' },
];

export default function TermsPage() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-10 prose prose-slate">
      <h1>Terms of service</h1>
      <p>Last updated: {LAST_UPDATED}</p>
      {sections.map((s) => (
        <section key={s.id} aria-labelledby={s.id}>
          <h2 id={s.id}>{s.title}</h2>
          <p>{s.body}</p>
        </section>
      ))}
    </div>
  );
}
