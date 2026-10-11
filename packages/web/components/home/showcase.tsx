import Link from 'next/link';
import { ArrowRight, BarChart3, MessageSquare, Shield, Search, TrendingUp, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardFooter } from '@/components/ui/card';

/** Static showcase blocks of the home page (W02 FR-005): no request at render, every link is a route that exists. */

const highlights = [
  {
    icon: Shield,
    title: 'Fault-Tolerant Payments',
    description: 'Outbox pattern, idempotency, double-entry ledger with zero dropped payments under chaos.',
    href: '/cart',
    badge: 'SD-20',
  },
  {
    icon: Search,
    title: 'Search & Discovery',
    description: 'Elasticsearch BM25 + vector search, autocomplete with top-K trie, faceted filtering.',
    href: '/search',
    badge: 'SD-37',
  },
  {
    icon: Zap,
    title: 'Real-Time Everything',
    description: 'SSE push hub, WebSocket chat, live auctions, launch event waiting rooms.',
    href: '/chat',
    badge: 'F-03',
  },
  {
    icon: BarChart3,
    title: 'ClickHouse Analytics',
    description: 'Checkout funnels, HyperLogLog uniques, ASOF JOINs, streaming Kafka → MV aggregates.',
    href: '/dashboard/seller',
    badge: 'SD-31',
  },
  {
    icon: MessageSquare,
    title: 'AI Shopping Assistant',
    description: 'Claude-powered chat with streamed responses, RAG help center, KYC document AI.',
    href: '/chat',
    badge: 'SD-42',
  },
  {
    icon: TrendingUp,
    title: '50+ Patterns',
    description: 'CQRS, sagas, circuit breakers, rate limiting, cache stampede prevention, and more.',
    href: '/developers/docs',
    badge: 'All',
  },
] as const;

export function ArchitectureHighlights() {
  return (
    <section className="py-20 sm:py-28" aria-labelledby="showcase-heading">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 id="showcase-heading" className="text-3xl font-heading font-bold tracking-tight">
            What this showcases
          </h2>
          <p className="mt-4 text-muted-foreground">
            Every feature is a system design interview answer, implemented end-to-end with production-grade code.
          </p>
        </div>
        <ul className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {highlights.map((item) => (
            <li key={item.title}>
              <Link href={item.href} className="block h-full focus-visible:outline-2 focus-visible:outline-ring">
                <Card className="group h-full transition-all hover:border-primary/20 hover:shadow-md motion-reduce:transition-none">
                  <CardContent className="pt-6">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                        <item.icon aria-hidden="true" className="size-5" />
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {item.badge}
                      </Badge>
                    </div>
                    <h3 className="font-heading font-semibold">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
                  </CardContent>
                  <CardFooter className="text-sm text-muted-foreground transition-colors group-hover:text-primary">
                    Explore
                    <ArrowRight aria-hidden="true" className="ml-1 size-3" />
                  </CardFooter>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const techs = [
  'NestJS',
  'PostgreSQL',
  'Kafka',
  'Redis',
  'Elasticsearch',
  'ClickHouse',
  'Stripe',
  'Rust',
  'Go',
  'Cloudflare Workers',
  'OpenTelemetry',
  'Docker',
  'Terraform',
] as const;

export function TechStackBanner() {
  return (
    <section className="border-t py-12" aria-labelledby="built-with-heading">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <h2 id="built-with-heading" className="mb-6 text-center text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Built with
        </h2>
        <ul className="flex flex-wrap items-center justify-center gap-3">
          {techs.map((tech) => (
            <li key={tech}>
              <Badge variant="outline" className="text-xs">
                {tech}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
