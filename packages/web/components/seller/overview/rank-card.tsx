'use client';

import type { SellerOverviewResponse } from '@/lib/api/seller';
import { SectionFrame, SectionUnavailable } from './section-frame';

type Rank = SellerOverviewResponse['rank'];

export const NOT_RANKED = 'Not ranked yet. Your shop appears on the leaderboard after its first paid order.';

/** "#3 of 120 shops · top 3 % this week" (W04 AS-16). `{notRanked: true}` is `404 not_ranked`, an empty state and not an error (AS-15). */
export function RankCard({ rank, onRetry }: { rank: Rank; onRetry: () => void }) {
  if (rank === null) {
    return (
      <SectionFrame title="Leaderboard rank">
        <SectionUnavailable text="Your rank is temporarily unavailable." onRetry={onRetry} />
      </SectionFrame>
    );
  }
  if ('notRanked' in rank) {
    return (
      <SectionFrame title="Leaderboard rank">
        <p className="text-sm text-muted-foreground">{NOT_RANKED}</p>
      </SectionFrame>
    );
  }
  const where = rank.category ? ` in ${rank.category}` : '';
  const when = rank.period.kind === 'month' ? 'this month' : 'this week';
  return (
    <SectionFrame title="Leaderboard rank">
      <p className="text-lg font-medium">{`#${rank.rank} of ${rank.of} shops${where} · top ${rank.topPercent} % ${when}`}</p>
    </SectionFrame>
  );
}
