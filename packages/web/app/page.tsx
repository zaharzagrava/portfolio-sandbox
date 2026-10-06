import { ProductCard, type ProductCardProps } from "@/components/product-card";
import { hitToCard, serverApiUrl, type SearchResponse } from "@/lib/api/catalog";
import { Suspense } from "react";
import Link from "next/link";
import {
  ShoppingBag,
  Search,
  Zap,
  Shield,
  BarChart3,
  MessageSquare,
  ArrowRight,
  Sparkles,
  TrendingUp,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/utils";

// ---------- Static hero (prerendered) ----------

function HeroSection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-background to-accent/10 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="secondary" className="mb-6">
            <Sparkles className="mr-1.5 size-3" />
            Enterprise Architecture Showcase
          </Badge>
          <h1 className="text-4xl font-heading font-bold tracking-tight sm:text-6xl">
            Marketplace{" "}
            <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              Sandbox
            </span>
          </h1>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">
            A production-grade distributed systems showcase featuring 53
            architectural patterns — from fault-tolerant payments to real-time
            chat, AI assistants, and analytics pipelines.
          </p>
          <div className="mt-10 flex items-center justify-center gap-x-4">
            <Button size="lg" asChild>
              <Link href="/search">
                <Search className="mr-2 size-4" />
                Browse Products
              </Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="/developers/docs">
                API Docs
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Decorative gradient blobs */}
      <div className="absolute -top-40 -right-40 size-80 rounded-full bg-primary/5 blur-3xl" />
      <div className="absolute -bottom-40 -left-40 size-80 rounded-full bg-accent/10 blur-3xl" />
    </section>
  );
}

// ---------- Architecture highlights ----------

const highlights = [
  {
    icon: Shield,
    title: "Fault-Tolerant Payments",
    description:
      "Outbox pattern, idempotency, double-entry ledger with zero dropped payments under chaos.",
    href: "/cart",
    badge: "SD-20",
  },
  {
    icon: Search,
    title: "Search & Discovery",
    description:
      "Elasticsearch BM25 + vector search, autocomplete with top-K trie, faceted filtering.",
    href: "/search",
    badge: "SD-37",
  },
  {
    icon: Zap,
    title: "Real-Time Everything",
    description:
      "SSE push hub, WebSocket chat, live auctions, launch event waiting rooms.",
    href: "/chat",
    badge: "F-03",
  },
  {
    icon: BarChart3,
    title: "ClickHouse Analytics",
    description:
      "Checkout funnels, HyperLogLog uniques, ASOF JOINs, streaming Kafka → MV aggregates.",
    href: "/dashboard/seller",
    badge: "SD-31",
  },
  {
    icon: MessageSquare,
    title: "AI Shopping Assistant",
    description:
      "Claude-powered chat with streamed responses, RAG help center, KYC document AI.",
    href: "/search",
    badge: "SD-42",
  },
  {
    icon: TrendingUp,
    title: "50+ Patterns",
    description:
      "CQRS, sagas, circuit breakers, rate limiting, cache stampede prevention, and more.",
    href: "/developers/docs",
    badge: "All",
  },
] as const;

function ArchitectureHighlights() {
  return (
    <section className="py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-heading font-bold tracking-tight">
            What This Showcases
          </h2>
          <p className="mt-4 text-muted-foreground">
            Every feature is a system design interview answer, implemented
            end-to-end with production-grade code.
          </p>
        </div>
        <div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {highlights.map((item) => (
            <Link key={item.title} href={item.href}>
              <Card className="group h-full transition-all hover:shadow-md hover:border-primary/20">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                      <item.icon className="size-5" />
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {item.badge}
                    </Badge>
                  </div>
                  <h3 className="font-heading font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                    {item.description}
                  </p>
                </CardContent>
                <CardFooter className="text-sm text-muted-foreground group-hover:text-primary transition-colors">
                  Explore
                  <ArrowRight className="ml-1 size-3" />
                </CardFooter>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Trending products (dynamic, streamed) ----------

function TrendingProductsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Card key={i}>
          <Skeleton className="aspect-square w-full rounded-t-lg" />
          <CardContent className="p-4 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-5 w-1/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface TrendingItem {
  id: string;
  title: string;
  price: number;
  category: string;
  score: number;
}

/**
 * Trending (SD-32): top products by recent views/add-to-carts. A fresh install has no traffic yet, so it
 * falls back to the catalog (search with no query) to keep the section useful.
 */
async function loadHomeProducts(): Promise<ProductCardProps[]> {
  const base = serverApiUrl();
  const trending: TrendingItem[] = await fetch(`${base}/api/trending`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  if (trending.length) {
    return trending.slice(0, 8).map((t) => ({ id: t.id, slug: t.id, name: t.title, shopName: t.category, price: t.price, rating: 0, reviewsCount: 0 }));
  }
  const search: SearchResponse | null = await fetch(`${base}/api/products/search?size=8`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return (search?.hits ?? []).map(hitToCard);
}

async function TrendingProducts() {
  const products = await loadHomeProducts();
  if (!products.length) {
    return <p className="text-muted-foreground" data-testid="home-no-products">No products yet.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="home-products">
      {products.map((product) => (
        <ProductCard key={product.id} {...product} />
      ))}
    </div>
  );
}

function TrendingSection() {
  return (
    <section className="bg-muted/30 py-20">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-heading font-bold tracking-tight">
              Trending Now
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Powered by Count-Min Sketch + top-K heap (SD-32)
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/search">
              View all
              <ArrowRight className="ml-1 size-3" />
            </Link>
          </Button>
        </div>
        <Suspense fallback={<TrendingProductsSkeleton />}>
          <TrendingProducts />
        </Suspense>
      </div>
    </section>
  );
}

// ---------- Tech stack banner ----------

function TechStackBanner() {
  const techs = [
    "NestJS", "PostgreSQL", "Kafka", "Redis", "Elasticsearch",
    "ClickHouse", "Stripe", "Rust", "Go", "Cloudflare Workers",
    "OpenTelemetry", "Docker", "Terraform",
  ];

  return (
    <section className="border-t py-12">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <p className="text-center text-xs font-medium uppercase tracking-widest text-muted-foreground mb-6">
          Built With
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {techs.map((tech) => (
            <Badge key={tech} variant="outline" className="text-xs">
              {tech}
            </Badge>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Page ----------

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <ArchitectureHighlights />
      <TrendingSection />
      <TechStackBanner />
    </>
  );
}
