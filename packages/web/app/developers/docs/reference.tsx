'use client';

import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getOpenApiDocument } from '@/lib/api/developers';
import { problemFromError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query-keys';

/**
 * The read-only API reference (W07 AS-27..AS-30): one client leaf over the validated OpenAPI description. It sends no
 * request to any API operation, renders descriptions as markdown without raw HTML and only follows `http:`/`https:` links.
 */

type Json = Record<string, unknown>;
type OpenApi = { info: Json; tags?: Array<{ name: string; description?: string }>; paths: Record<string, Json>; components?: Json } & Json;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const FIVE_MINUTES = 5 * 60 * 1000;

type Operation = { id: string; method: string; path: string; tag: string; data: Json };

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function resolveRef(doc: OpenApi, node: unknown): Json | undefined {
  let current = node;
  for (let hops = 0; hops < 10 && isObject(current) && typeof current.$ref === 'string'; hops += 1) {
    const ref = current.$ref;
    if (!ref.startsWith('#/')) return undefined;
    current = ref
      .slice(2)
      .split('/')
      .reduce<unknown>((found, key) => (isObject(found) ? found[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
  }
  return isObject(current) ? current : undefined;
}

const refName = (node: unknown): string | undefined => (isObject(node) && typeof node.$ref === 'string' ? node.$ref.split('/').pop() : undefined);

/** A compact, readable outline of a schema: one line per property, nested two levels deep, cycles cut. */
function schemaLines(doc: OpenApi, schema: unknown, depth = 0, seen: string[] = []): string[] {
  const name = refName(schema);
  if (name && seen.includes(name)) return [`${'  '.repeat(depth)}(${name})`];
  const resolved = resolveRef(doc, schema);
  if (!resolved) return [];
  const nextSeen = name ? [...seen, name] : seen;
  const pad = '  '.repeat(depth);
  const type = resolved.type;
  if (type === 'array') {
    const itemName = refName(resolved.items);
    const items = depth < 2 ? schemaLines(doc, resolved.items, depth + 1, nextSeen) : [];
    return [`${pad}array of ${itemName ?? (isObject(resolved.items) ? String(resolved.items.type ?? 'value') : 'value')}`, ...items];
  }
  const properties = isObject(resolved.properties) ? resolved.properties : undefined;
  if (!properties) return [`${pad}${Array.isArray(resolved.enum) ? `enum ${resolved.enum.join(' | ')}` : String(type ?? 'value')}`];
  const required = Array.isArray(resolved.required) ? resolved.required : [];
  const lines: string[] = name && depth === 0 ? [`${pad}${name}`] : [];
  for (const [key, value] of Object.entries(properties)) {
    const child = resolveRef(doc, value);
    const label = refName(value) ?? (child?.type === 'array' ? `array of ${refName(isObject(child.items) ? child.items : undefined) ?? String(isObject(child.items) ? child.items.type : 'value')}` : String(child?.type ?? 'value'));
    lines.push(`${pad}  ${key}: ${label}${required.includes(key) ? ' (required)' : ''}`);
    if (depth < 1 && (child?.type === 'object' || refName(value))) {
      const nested = schemaLines(doc, value, depth + 2, nextSeen).slice(refName(value) ? 1 : 0);
      lines.push(...nested);
    }
  }
  return lines;
}

function bodySchema(doc: OpenApi, content: unknown): unknown {
  const media = isObject(content) ? (content['application/json'] ?? Object.values(content)[0]) : undefined;
  return isObject(media) ? media.schema : undefined;
}

function groupOperations(doc: OpenApi): Array<{ tag: string; description?: string; operations: Operation[] }> {
  const groups = new Map<string, { tag: string; description?: string; operations: Operation[] }>();
  for (const tag of doc.tags ?? []) groups.set(tag.name, { tag: tag.name, description: tag.description, operations: [] });
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const data = item[method];
      if (!isObject(data)) continue;
      const tags = Array.isArray(data.tags) && data.tags.length > 0 ? data.tags.filter((tag): tag is string => typeof tag === 'string') : ['other'];
      for (const tag of tags) {
        if (!groups.has(tag)) groups.set(tag, { tag, operations: [] });
        groups.get(tag)!.operations.push({ id: `${method}:${path}:${tag}`, method: method.toUpperCase(), path, tag, data });
      }
    }
  }
  return [...groups.values()].filter((group) => group.operations.length > 0);
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm prose-slate max-w-none dark:prose-invert">
      <ReactMarkdown
        components={{
          a: ({ href, children: label }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {label}{' '}
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <span>{label}</span>
            ),
          // The page owns the heading outline: a heading in a description is just emphasised text.
          h1: ({ children: label }) => <p><strong>{label}</strong></p>,
          h2: ({ children: label }) => <p><strong>{label}</strong></p>,
          h3: ({ children: label }) => <p><strong>{label}</strong></p>,
          h4: ({ children: label }) => <p><strong>{label}</strong></p>,
          h5: ({ children: label }) => <p><strong>{label}</strong></p>,
          h6: ({ children: label }) => <p><strong>{label}</strong></p>,
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs" tabIndex={0}>
      <code>{children}</code>
    </pre>
  );
}

function CopyExample({ example }: { example: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(example);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <CodeBlock>{example}</CodeBlock>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={copy}>
          Copy example
        </Button>
        <span role="status" className="text-sm">
          {copied ? 'Copied' : ''}
        </span>
      </div>
    </div>
  );
}

function exampleFor(operation: Operation): string {
  const hasBody = isObject(operation.data.requestBody);
  return [
    `curl -X ${operation.method} "$API_BASE${operation.path}" \\`,
    `  -H "Authorization: Bearer $API_KEY"${hasBody ? ' \\' : ''}`,
    ...(hasBody ? ['  -H "Content-Type: application/json" \\', '  --data @body.json'] : []),
  ].join('\n');
}

function OperationView({ doc, operation }: { doc: OpenApi; operation: Operation }) {
  const [open, setOpen] = useState(false);
  const buttonId = useId();
  const panelId = useId();
  const { data } = operation;
  const scope = text(data['x-required-scope']) ?? (Array.isArray(data.security) ? Object.values(isObject(data.security[0]) ? data.security[0] : {}).flat().filter((s): s is string => typeof s === 'string').join(', ') : undefined);
  const deprecated = data.deprecated === true;
  const sunset = text(data['x-sunset']);
  const replacement = text(data['x-replacement']);
  const parameters = (Array.isArray(data.parameters) ? data.parameters : []).map((entry) => resolveRef(doc, entry)).filter((entry): entry is Json => !!entry);
  const request = bodySchema(doc, isObject(data.requestBody) ? (resolveRef(doc, data.requestBody)?.content ?? data.requestBody.content) : undefined);
  const responses = isObject(data.responses) ? Object.entries(data.responses) : [];
  const summary = text(data.summary);

  return (
    <li className="rounded-md border">
      <h4 className="text-base">
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-semibold">{operation.method}</span>
          <span className="break-all font-mono text-sm">{operation.path}</span>
          {summary && <span className="text-sm text-muted-foreground"> {summary}</span>}
          {deprecated && <span className="rounded border border-amber-600 px-1.5 text-xs text-amber-700 dark:text-amber-400"> Deprecated</span>}
        </button>
      </h4>
      {open && (
        <div id={panelId} role="region" aria-labelledby={buttonId} className="flex flex-col gap-4 border-t px-3 py-4">
          {deprecated && (
            <p className="text-sm">
              <strong>Deprecated.</strong>
              {sunset && <> Sunset: {sunset.slice(0, 10)}.</>}
              {replacement && (
                <>
                  {' '}
                  Use <code>{replacement}</code> instead.
                </>
              )}
            </p>
          )}
          {text(data.description) && <Markdown>{text(data.description)!}</Markdown>}
          {scope && (
            <p className="text-sm">
              Required scope: <code>{scope}</code>
            </p>
          )}
          {parameters.length > 0 && (
            <div className="max-w-full overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="pb-1 text-left font-medium">Parameters</caption>
                <thead>
                  <tr>
                    <th scope="col" className="pr-4">Name</th>
                    <th scope="col" className="pr-4">In</th>
                    <th scope="col" className="pr-4">Required</th>
                    <th scope="col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {parameters.map((parameter) => (
                    <tr key={`${String(parameter.in)}:${String(parameter.name)}`} className="align-top">
                      <td className="pr-4 font-mono">{String(parameter.name)}</td>
                      <td className="pr-4">{String(parameter.in)}</td>
                      <td className="pr-4">{parameter.required === true ? 'yes' : 'no'}</td>
                      <td>{text(parameter.description) ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {request !== undefined && (
            <div>
              <p className="text-sm font-medium">Request body</p>
              <CodeBlock>{schemaLines(doc, request).join('\n')}</CodeBlock>
            </div>
          )}
          {responses.length > 0 && (
            <div className="max-w-full overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="pb-1 text-left font-medium">Responses</caption>
                <thead>
                  <tr>
                    <th scope="col" className="pr-4">Code</th>
                    <th scope="col">Meaning and shape</th>
                  </tr>
                </thead>
                <tbody>
                  {responses.map(([code, response]) => {
                    const resolved = resolveRef(doc, response) ?? {};
                    const shape = schemaLines(doc, bodySchema(doc, resolved.content));
                    return (
                      <tr key={code} className="align-top">
                        <td className="pr-4 font-mono">{code}</td>
                        <td>
                          <span>{text(resolved.description) ?? ''}</span>
                          {shape.length > 0 && <CodeBlock>{shape.join('\n')}</CodeBlock>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div>
            <p className="text-sm font-medium">Example</p>
            <CopyExample example={exampleFor(operation)} />
          </div>
        </div>
      )}
    </li>
  );
}

function Placeholder() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading the API reference…</span>
      <Skeleton className="h-8 w-48" />
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-12 w-full" />
      ))}
    </div>
  );
}

function Unavailable({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }): ReactNode {
  const requestId = problemFromError(error).requestId;
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border p-4">
      <p>The API reference is temporarily unavailable.</p>
      {requestId && <p className="text-sm text-muted-foreground">Reference: {requestId}</p>}
      <Button type="button" onClick={onRetry} disabled={retrying} className="min-h-11">
        Try again
      </Button>
    </div>
  );
}

/** The reference area under the page's own h1 and static sections: an h2, then the state that replaces itself in place. */
export function Reference() {
  return (
    <section aria-labelledby="operations-heading" className="flex flex-col gap-4">
      <h2 id="operations-heading" className="text-2xl font-semibold">
        Operations
      </h2>
      <ReferenceBody />
    </section>
  );
}

function ReferenceBody() {
  const query = useQuery({ queryKey: queryKeys.developers.openapi, queryFn: getOpenApiDocument, staleTime: FIVE_MINUTES });

  if (query.isPending) return <Placeholder />;
  if (query.isError || !query.data) return <Unavailable error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;

  const doc = query.data as unknown as OpenApi;
  const groups = groupOperations(doc);
  const links = groups.map((group) => (
    <li key={group.tag}>
      <a href={`#operations-${group.tag}`} className="block min-h-11 py-2 text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
        {group.tag}
      </a>
    </li>
  ));

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-10">
      <div className="lg:w-56 lg:shrink-0">
        <details className="rounded-md border px-4 lg:hidden">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Groups</summary>
          <ul className="pb-2">{links}</ul>
        </details>
        <nav aria-label="Operations" className="sticky top-24 hidden lg:block">
          <p className="mb-2 text-sm font-medium">Groups</p>
          <ul>{links}</ul>
        </nav>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        {groups.map((group) => (
          <section key={group.tag} aria-labelledby={`operations-${group.tag}`}>
            <h3 id={`operations-${group.tag}`} className="mb-2 scroll-mt-24 text-xl font-semibold">
              {group.tag}
            </h3>
            {group.description && <Markdown>{group.description}</Markdown>}
            <ul className="mt-3 flex flex-col gap-3">
              {group.operations.map((operation) => (
                <OperationView key={operation.id} doc={doc} operation={operation} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
