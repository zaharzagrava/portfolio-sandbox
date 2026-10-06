import { topOwners, type ConceptModel } from './concepts.ts';
import type { Graph } from './graph.ts';

/** What `Prose` needs from a page to build links relative to it. */
export interface LinkTarget {
  path: string;
  src(file: string, line?: number, text?: string): string;
  page(to: string, text: string): string;
}

const BRANDS = new Set([
  'NestJS', 'GraphQL', 'PostgreSQL', 'TypeScript', 'JavaScript', 'ScyllaDB', 'MongoDB', 'DynamoDB', 'OpenAPI', 'GitHub', 'GitLab', 'RabbitMQ', 'OpenSearch',
  'ElasticSearch', 'CloudFront', 'CloudWatch', 'LaunchDarkly', 'SendGrid', 'PagerDuty', 'OAuth', 'WebSocket', 'WebSockets', 'WebRTC', 'PayPal', 'OpenTelemetry',
  'Node.js', 'Next.js', 'Vue.js', 'Nest.js', 'Express.js', 'Socket.io', 'Chart.js', 'React.js',
]);

const IDENT = [
  /(?<![\w.-])[\w-]+(?:\.[\w-]+)*\.(?:ts|tsx|js|json|sql|md|yml|yaml)\b/g, // payment.service.ts, bis-utils.service.ts
  /(?<![\w.-])[A-Za-z_]\w+(?:\.[A-Za-z_][\w-]*\w)+\b/g, // payments.requests, ledger.journal_posted, payouts.run-weekly
  /(?<![\w-])[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g, // PaymentController, JournalPosted, BigInt
  /(?<![\w-])[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, // idempotencyKey, defineEvent
  /(?<![\w-])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // FEE_AMOUNT
  /(?<![\w-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, // payout_status
];
const QUOTED = /(['"])([A-Za-z0-9_][A-Za-z0-9_.:/-]*)\1/g;
const SPANS = /(`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Post-processes model-written prose: identifiers, topics and event names go in code spans, known symbols link to
 * the concept page that owns their file (or the source line), and concept titles link to their page.
 * Idempotent and applied at render time, so improving it never needs a regeneration.
 */
export class Prose {
  private readonly symbols = new Map<string, { file: string; line: number }[]>();
  private readonly known = new Set<string>();
  private readonly titles: { re: RegExp; id: string }[];
  private readonly model: ConceptModel;

  constructor(graph: Graph, model: ConceptModel) {
    this.model = model;
    for (const f of graph.files.values()) for (const e of f.exports) if (e.name.length > 2) this.symbols.set(e.name, [...(this.symbols.get(e.name) ?? []), { file: f.path, line: e.line }]);
    for (const e of graph.events) (this.known.add(e.name), this.known.add(e.const));
    for (const j of graph.jobs) this.known.add(j.name);
    for (const f of graph.files.values()) for (const r of f.routes) if (r.kind === 'message') this.known.add(r.path.replace(/^['"]|['"]$/g, ''));
    // Only titles that name exactly one topic in the whole graph can be linked safely.
    const count = new Map<string, number>();
    for (const c of model.concepts) count.set(c.title.toLowerCase(), (count.get(c.title.toLowerCase()) ?? 0) + 1);
    const titles = model.concepts.filter((c) => c.title.trim().split(/\s+/).length >= 2 && count.get(c.title.toLowerCase()) === 1).sort((a, b) => b.title.length - a.title.length);
    this.titles = titles.map((c) => ({ re: new RegExp(`(?<![\\w\`\\[])${esc(c.title)}(?![\\w\`\\]])`, 'gi'), id: c.id }));
  }

  fmt(input: string, from: LinkTarget): string {
    return input
      .split(SPANS)
      .map((part, i) => (i % 2 ? this.relink(part, from) : this.plain(part, from)))
      .join('');
  }

  /** A code span `X` that names a known symbol becomes a link; anything else is left as written. */
  private relink(span: string, from: LinkTarget): string {
    const m = /^`([^`]+)`$/.exec(span);
    return m ? this.code(m[1], from) : span;
  }

  private code(name: string, from: LinkTarget): string {
    const defs = this.symbols.get(name);
    const text = `\`${name}\``;
    if (!defs || defs.length !== 1) return text;
    const owner = topOwners(this.model, defs[0].file)[0];
    if (owner && owner.page !== from.path) return from.page(owner.page, text);
    return from.src(defs[0].file, defs[0].line, text);
  }

  private plain(segment: string, from: LinkTarget): string {
    const held: string[] = [];
    const hold = (s: string) => `\u0000${held.push(s) - 1}\u0000`;
    let out = segment;
    for (const { re, id } of this.titles) {
      const c = this.model.byId.get(id)!;
      if (c.page === from.path) continue;
      out = out.replace(re, (m) => hold(from.page(c.page, m)));
    }
    out = out.replace(QUOTED, (m, _q, inner: string) => (/[._:/-]/.test(inner) || this.known.has(inner) || this.symbols.has(inner) ? hold(this.code(inner, from)) : m));
    for (const re of IDENT) {
      out = out.replace(re, (m) => {
        if (BRANDS.has(m) || /^\d/.test(m)) return m;
        return hold(this.code(m, from));
      });
    }
    // bare names of events, jobs and topics that the patterns above do not catch
    out = out.replace(/\b[A-Za-z][A-Za-z0-9_]{2,}\b/g, (m) => (this.known.has(m) ? hold(this.code(m, from)) : m));
    return out.replace(/\u0000(\d+)\u0000/g, (_, n) => held[Number(n)]);
  }
}
