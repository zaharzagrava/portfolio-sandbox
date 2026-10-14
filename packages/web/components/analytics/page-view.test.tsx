import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/events', () => ({ sendEvents: vi.fn() }));
const navigation = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));

import { sendEvents } from '@/lib/api/events';
import { __resetTrackForTests } from '@/lib/analytics/track';
import { PageView } from './page-view';

const send = vi.mocked(sendEvents);
const TOKEN = 'inv_SECRETtokenvalue1234567890';

function setPrivacy(signal: 'gpc' | 'none') {
  Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: signal === 'gpc' ? true : undefined });
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
}

/** What reached the wire once the page hides (the events are batched until then). */
function sentPages(): string[] {
  window.dispatchEvent(new Event('pagehide'));
  return send.mock.calls.flatMap((call) => call[0]).filter((event) => event.name === 'page_view').map((event) => event.page ?? '');
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ ok: true });
  setPrivacy('none');
  navigation.pathname = '/';
  __resetTrackForTests();
});

afterEach(() => __resetTrackForTests());

describe('W07 page view (AS-35)', () => {
  it('W07 AS-35: the first load emits one page_view under the route template', () => {
    navigation.pathname = '/products/iphone-15';
    render(<PageView />);
    expect(sentPages()).toEqual(['/products/:slug']);
  });

  it('W07 AS-35: each in-app navigation emits one more; a re-render on the same address emits none', () => {
    navigation.pathname = '/search';
    const view = render(<PageView />);
    view.rerender(<PageView />);
    navigation.pathname = `/invites/${TOKEN}`;
    view.rerender(<PageView />);
    view.rerender(<PageView />);
    expect(sentPages()).toEqual(['/search', '/invites/:token']);
  });

  it('W07 AS-35: development double-mounting still reports a page once', () => {
    navigation.pathname = '/privacy';
    render(
      <StrictMode>
        <PageView />
      </StrictMode>,
    );
    expect(sentPages()).toEqual(['/privacy']);
  });

  it('W07 AS-35: an unmatched address is reported as /not-found and never carries its text', () => {
    navigation.pathname = `/nothing/${TOKEN}`;
    render(<PageView />);
    const pages = sentPages();
    expect(pages).toEqual(['/not-found']);
    expect(JSON.stringify(send.mock.calls)).not.toContain(TOKEN);
  });

  it('W07 AS-35: nothing is emitted when Global Privacy Control is on', () => {
    setPrivacy('gpc');
    navigation.pathname = '/search';
    render(<PageView />);
    expect(sentPages()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
