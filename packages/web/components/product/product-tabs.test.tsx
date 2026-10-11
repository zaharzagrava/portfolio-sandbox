import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

vi.mock('next/navigation', async () => {
  const { useEffect, useReducer } = await import('react');
  return {
    usePathname: () => window.location.pathname,
    useSearchParams: () => {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        window.addEventListener('test-nav', force);
        return () => window.removeEventListener('test-nav', force);
      }, []);
      return new URLSearchParams(window.location.search);
    },
  };
});

import { ProductTabs } from '@/components/product/product-tabs';
import { parseProductPageView, productViewParams } from '@/lib/product/page-view';

const realPush = window.history.pushState.bind(window.history);
let mounts: string[] = [];

function Probe({ name }: { name: string }) {
  mounts.push(name);
  return <p>{`${name} content`}</p>;
}

const tabs = [
  { id: 'details', label: 'Details' },
  { id: 'ask', label: 'Ask about this product' },
  { id: 'discussions', label: 'Discussions' },
] as const;

const panels: Record<string, ReactNode> = {
  details: <Probe name="details" />,
  ask: <Probe name="ask" />,
  discussions: <Probe name="discussions" />,
};

beforeEach(() => {
  mounts = [];
  window.history.pushState = (...args) => {
    realPush(...args);
    window.dispatchEvent(new Event('test-nav'));
  };
  window.history.replaceState(null, '', '/products/abc');
});

describe('ProductTabs', () => {
  it('W02 AS-40: uses the ARIA tab pattern with only the active panel exposed', () => {
    render(<ProductTabs tabs={tabs} panels={panels} />);
    expect(screen.getByRole('tablist', { name: 'Product information' })).toBeInTheDocument();
    const [details, ask, discussions] = screen.getAllByRole('tab');
    expect(details).toHaveAttribute('aria-selected', 'true');
    expect(ask).toHaveAttribute('aria-selected', 'false');
    expect(details).toHaveAttribute('tabindex', '0');
    expect(ask).toHaveAttribute('tabindex', '-1');
    expect(discussions).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', details!.id);
    expect(details).toHaveAttribute('aria-controls', panel.id);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByText('details content')).toBeVisible();
  });

  it('W02 AS-40: Left/Right/Home/End move the focus around the tabs, wrapping; Enter selects', async () => {
    const user = userEvent.setup();
    render(<ProductTabs tabs={tabs} panels={panels} />);
    const [details, ask, discussions] = screen.getAllByRole('tab');
    details!.focus();
    await user.keyboard('{ArrowRight}');
    expect(ask).toHaveFocus();
    await user.keyboard('{End}');
    expect(discussions).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(details).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(discussions).toHaveFocus();
    await user.keyboard('{Home}');
    expect(details).toHaveFocus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(ask).toHaveAttribute('aria-selected', 'true');
    expect(window.location.search).toBe('?tab=ask');
  });

  it('W02 AS-40: the selected tab is in the address; details is the default and is omitted', async () => {
    const user = userEvent.setup();
    render(<ProductTabs tabs={tabs} panels={panels} />);
    await user.click(screen.getByRole('tab', { name: 'Discussions' }));
    expect(window.location.search).toBe('?tab=discussions');
    await user.click(screen.getByRole('tab', { name: 'Details' }));
    expect(window.location.search).toBe('');
  });

  it('W02 AS-40: a change pushes a history entry and keeps other parameters', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/products/abc?ref=friend');
    const before = window.history.length;
    render(<ProductTabs tabs={tabs} panels={panels} />);
    await user.click(screen.getByRole('tab', { name: 'Ask about this product' }));
    expect(window.history.length).toBe(before + 1);
    expect(window.location.search).toBe('?ref=friend&tab=ask');
  });

  it('W02 AS-40: a deep link opens that panel', () => {
    window.history.replaceState(null, '', '/products/abc?tab=discussions');
    render(<ProductTabs tabs={tabs} panels={panels} />);
    expect(screen.getByRole('tab', { name: 'Discussions' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('discussions content')).toBeVisible();
  });

  it.each(['nonsense', 'pickup', 'DETAILS'])('W02 AS-40: an invalid or unavailable tab (%s) is the details tab', (value) => {
    window.history.replaceState(null, '', `/products/abc?tab=${value}`);
    render(<ProductTabs tabs={tabs} panels={panels} />);
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
  });

  it('W02 AS-40: a tab content mounts when first opened and is kept afterwards, hidden', async () => {
    const user = userEvent.setup();
    render(<ProductTabs tabs={tabs} panels={panels} />);
    expect(mounts).toEqual(['details']);
    await user.click(screen.getByRole('tab', { name: 'Ask about this product' }));
    expect(mounts).toContain('ask');
    expect(mounts).not.toContain('discussions');
    await user.click(screen.getByRole('tab', { name: 'Details' }));
    // The ask panel stays mounted but is not exposed.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(document.querySelectorAll('[role="tabpanel"][hidden]').length).toBe(2);
    expect(screen.getByText('ask content', { ignore: '' })).not.toBeVisible();
  });

  it('W02 AS-40: back/forward re-read the address', async () => {
    const user = userEvent.setup();
    render(<ProductTabs tabs={tabs} panels={panels} />);
    await user.click(screen.getByRole('tab', { name: 'Discussions' }));
    window.history.replaceState(null, '', '/products/abc');
    window.dispatchEvent(new Event('test-nav'));
    expect(await screen.findByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('product page view', () => {
  it('W02 AS-40: parsing drops invalid values and keeps the valid ones', () => {
    const view = parseProductPageView(new URLSearchParams('tab=nope&sort=top&window=year&post=zzz&ref=ab c&ad=1'));
    expect(view).toEqual({ tab: 'details', sort: 'top', window: 'year', ad: '1' });
  });

  it('W02 AS-45: window is only kept with sort=top', () => {
    expect(parseProductPageView(new URLSearchParams('sort=new&window=day'))).toEqual({ tab: 'details', sort: 'new' });
  });

  it('W02 AS-45: the query string omits the defaults', () => {
    expect(productViewParams({ tab: 'details', sort: 'hot' }).toString()).toBe('');
    expect(productViewParams({ tab: 'discussions', sort: 'top', window: 'week' }).toString()).toBe('tab=discussions&sort=top&window=week');
  });
});
