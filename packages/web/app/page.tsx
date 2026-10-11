import Link from 'next/link';
import { Suspense } from 'react';
import { Search, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CategoryRow, CategoryRowSkeleton } from '@/components/home/category-row';
import { ArchitectureHighlights, TechStackBanner } from '@/components/home/showcase';
import { TrendingRailCards, TrendingRailHeader, TrendingRailSkeleton } from '@/components/home/trending-rail';
import { SearchBox } from '@/components/search/search-box';
import { searchHref } from '@/lib/routes';

/**
 * Home (W02 US1): the hero with the search box and the showcase are static; the category shortcuts and the trending rail
 * are separate async sections under their own boundary, so the page is usable before they arrive (AS-01).
 */
export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-background to-accent/10 py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-heading font-bold tracking-tight sm:text-6xl">
              Marketplace{' '}
              <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">Sandbox</span>
            </h1>
            <p className="mt-6 text-lg leading-8 text-muted-foreground">
              A production-grade distributed systems showcase featuring 53 architectural patterns — from fault-tolerant payments to
              real-time chat, AI assistants, and analytics pipelines.
            </p>
            <div className="mx-auto mt-8 max-w-[40rem]">
              <SearchBox variant="hero" />
            </div>
            <Suspense fallback={<CategoryRowSkeleton />}>
              <CategoryRow />
            </Suspense>
            <div className="mt-8 flex items-center justify-center gap-x-4">
              <Button size="lg" asChild>
                <Link href={searchHref()}>
                  <Search aria-hidden="true" className="mr-2 size-4" />
                  Browse products
                </Link>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <Link href="/developers/docs">
                  API docs
                  <ArrowRight aria-hidden="true" className="ml-2 size-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
        <div aria-hidden="true" className="absolute -top-40 -right-40 size-80 rounded-full bg-primary/5 blur-3xl" />
        <div aria-hidden="true" className="absolute -bottom-40 -left-40 size-80 rounded-full bg-accent/10 blur-3xl" />
      </section>

      <section className="bg-muted/30 py-16" aria-labelledby="trending-heading">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <TrendingRailHeader />
          <Suspense fallback={<TrendingRailSkeleton />}>
            <TrendingRailCards />
          </Suspense>
        </div>
      </section>

      <ArchitectureHighlights />
      <TechStackBanner />
    </>
  );
}
