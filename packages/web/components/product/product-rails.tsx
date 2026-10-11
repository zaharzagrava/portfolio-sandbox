import type { RecommendationItem, TrendingItem } from '@marketplace-sandbox/contracts';
import { RailCard } from '@/components/product/rail-card';
import { recommendationItemToCard, railItemToCard } from '@/lib/product/cards';
import { TRENDING_RAIL_SIZE } from '@/lib/product/parse-page';
import { facetLabel } from '@/lib/search/facet-label';

function Rail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="mt-12">
      <h2 className="mb-6 text-2xl font-bold tracking-tight">{title}</h2>
      <ul className="grid grid-cols-2 gap-4 md:gap-6 lg:grid-cols-4">{children}</ul>
    </section>
  );
}

/**
 * The two rails under the tabs (W02 FR-058, AS-39). A missing or empty section renders nothing at all: no heading and no
 * message. Trending shows at most eight cards, the product itself already removed by `parseProductPage`.
 */
export function ProductRails({
  recommendations,
  trending,
  category,
}: {
  recommendations: readonly RecommendationItem[] | null;
  trending: readonly TrendingItem[] | null;
  category: string;
}) {
  const bought = recommendations ?? [];
  const inCategory = (trending ?? []).slice(0, TRENDING_RAIL_SIZE);
  if (bought.length === 0 && inCategory.length === 0) return null;
  return (
    <>
      {bought.length > 0 ? (
        <Rail title="Frequently bought together">
          {bought.map((item) => (
            <li key={item.productId}>
              <RailCard {...recommendationItemToCard(item)} />
            </li>
          ))}
        </Rail>
      ) : null}
      {inCategory.length > 0 ? (
        <Rail title={`Trending in ${facetLabel(category)}`}>
          {inCategory.map((item) => (
            <li key={item.productId}>
              <RailCard {...{ ...railItemToCard(item), rank: undefined }} />
            </li>
          ))}
        </Rail>
      ) : null}
    </>
  );
}
