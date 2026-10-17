import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CardPageSkeleton, DetailPageSkeleton, ListPageSkeleton, OverviewSkeleton } from './page-skeletons';

const skeletons = [
  ['overview', <OverviewSkeleton key="o" />],
  ['list', <ListPageSkeleton key="l" />],
  ['list without filters', <ListPageSkeleton key="l2" filters={false} />],
  ['detail', <DetailPageSkeleton key="d" />],
  ['card', <CardPageSkeleton key="c" />],
] as const;

describe('W04 page skeletons', () => {
  it.each(skeletons)('W04 AS-91: the %s skeleton is shaped like its page, decorative, and never says "Loading..."', (_name, element) => {
    const { container } = render(element);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(3);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toBe('');
    expect(container.querySelector('svg, img, [role="progressbar"], [role="status"]')).toBeNull();
  });

  it('W04 AS-96: the overview skeleton has the tiles, the two panels, the rank and top-products pair, and the chart in order', () => {
    const { container } = render(<OverviewSkeleton />);
    const regions = [...container.querySelectorAll('[data-region]')].map((node) => node.getAttribute('data-region'));
    expect(regions).toEqual(['header', 'live', 'today', 'tiles', 'rank', 'chart', 'top-products']);
    expect(container.querySelectorAll('[data-region="tiles"] [data-slot="skeleton"]')).toHaveLength(8);
  });

  it('W04 AS-91: the list skeleton has a toolbar (when filters apply), a header row and body rows', () => {
    const { container } = render(<ListPageSkeleton rows={5} />);
    expect(container.querySelector('[data-region="toolbar"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-region="row"]')).toHaveLength(5);
    expect(render(<ListPageSkeleton filters={false} />).container.querySelector('[data-region="toolbar"]')).toBeNull();
  });
});
