import Link from 'next/link';
import { Reference } from './reference';

// Completed by the root layout's template: "API documentation · Marketplace".
export const metadata = { title: 'API documentation' };

/**
 * The seller API reference (W07 AS-27..AS-30), inside the common frame: a Server Component for the static text; the
 * operations are the client leaf `Reference`, which reads the description from the same-origin route and is bundled
 * with this route only.
 */
export default function ApiDocsPage() {
  return (
    <div className="container mx-auto flex flex-col gap-10 px-4 py-10">
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">API documentation</h1>
        <p>
          The marketplace API lets a seller manage products, stock and orders from their own systems. It is key-authenticated: create a seller API key
          under <strong>Developers → API keys</strong> in your <Link href="/dashboard/seller" className="underline underline-offset-4">seller dashboard</Link>, and choose the scopes it needs. New versions are announced
          before an older one is retired.
        </p>
        <p>This page is a reference only. It does not send requests.</p>
      </div>

      <div className="grid max-w-3xl gap-8">
        <section aria-labelledby="authentication" className="flex flex-col gap-2">
          <h2 id="authentication" className="scroll-mt-24 text-2xl font-semibold">Authentication</h2>
          <p>
            Send the key as a bearer token: <code>Authorization: Bearer sk_live_…</code> for your shop, or <code>sk_test_…</code> for the sandbox. A key
            can only do what its scopes allow; a missing scope is answered with <code>403</code>. Keep keys on your servers and rotate them from the
            dashboard.
          </p>
        </section>

        <section aria-labelledby="errors" className="flex flex-col gap-2">
          <h2 id="errors" className="scroll-mt-24 text-2xl font-semibold">Errors</h2>
          <p>
            Failures are <code>application/problem+json</code> (<a className="underline underline-offset-4" href="https://www.rfc-editor.org/rfc/rfc9457" target="_blank" rel="noopener noreferrer">RFC 9457<span className="sr-only"> (opens in a new tab)</span></a>) with these
            fields:
          </p>
          <ul className="list-disc pl-6">
            <li><code>type</code>: a URI that identifies the kind of problem.</li>
            <li><code>title</code>: a short summary.</li>
            <li><code>status</code>: the HTTP status.</li>
            <li><code>detail</code>: what went wrong in this case.</li>
            <li><code>instance</code>: the address of this occurrence.</li>
            <li><code>requestId</code>: quote it when you ask for support.</li>
            <li><code>code</code>: a stable code to branch on.</li>
            <li><code>errors</code>: field-level problems of a rejected body.</li>
          </ul>
          <p>
            <code>429</code> and <code>503</code> answers carry a <code>Retry-After</code> header: wait that many seconds before trying again.
          </p>
        </section>

        <section aria-labelledby="deprecation" className="flex flex-col gap-2">
          <h2 id="deprecation" className="scroll-mt-24 text-2xl font-semibold">Deprecation</h2>
          <p>
            A version or operation that will go away is marked in the reference and, on every response that uses it, by the <code>Deprecation</code> header
            (since when it is deprecated) and the <code>Sunset</code> header (the date it stops working). Move to the replacement named in the reference before
            that date.
          </p>
        </section>
      </div>

      <Reference />
    </div>
  );
}
