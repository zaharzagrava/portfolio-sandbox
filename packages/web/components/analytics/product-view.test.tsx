import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/events', () => ({ sendEvents: vi.fn() }));

import { sendEvents } from '@/lib/api/events';
import { __resetTrackForTests } from '@/lib/analytics/track';
import { ProductView } from './product-view';

const send = vi.mocked(sendEvents);

function setPrivacy(signal: 'gpc' | 'none') {
  Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: signal === 'gpc' ? true : undefined });
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
}

/** The `product_view` events that reached the wire once the page hides (events are batched until then). */
function views() {
  window.dispatchEvent(new Event('pagehide'));
  return send.mock.calls.flatMap((call) => call[0]).filter((event) => event.name === 'product_view');
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ ok: true });
  setPrivacy('none');
  window.history.replaceState(null, '', '/products/p1?tab=pickup#x');
  __resetTrackForTests();
});

afterEach(() => __resetTrackForTests());

describe('ProductView', () => {
  it('W02 AS-67: one product_view per page view, carrying product_id and category and the path without query or fragment', () => {
    render(<ProductView productId="p1" category="audio" />);
    const [only, ...rest] = views();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ name: 'product_view', page: '/products/p1', props: { product_id: 'p1', category: 'audio' } });
    expect(only?.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('W02 AS-67: the development double mount and re-renders (tab changes) add none', () => {
    const view = render(
      <StrictMode>
        <ProductView productId="p1" category="audio" />
      </StrictMode>,
    );
    window.history.replaceState(null, '', '/products/p1?tab=ask');
    view.rerender(
      <StrictMode>
        <ProductView productId="p1" category="audio" />
      </StrictMode>,
    );
    expect(views()).toHaveLength(1);
  });

  it('W02 AS-67: opening another product adds one for it', () => {
    const view = render(<ProductView productId="p1" category="audio" />);
    window.history.replaceState(null, '', '/products/p2');
    view.rerender(<ProductView productId="p2" category="video" />);
    expect(views().map((event) => event.props)).toEqual([
      { product_id: 'p1', category: 'audio' },
      { product_id: 'p2', category: 'video' },
    ]);
  });

  it('W02 AS-67: a category outside the catalogue alphabet is normalised, or left out when it cannot be one', () => {
    render(<ProductView productId="p1" category="Home & Garden" />);
    expect(views()[0]?.props).toEqual({ product_id: 'p1', category: 'home-garden' });
  });

  it('W02 AS-68: nothing is queued under Global Privacy Control', () => {
    setPrivacy('gpc');
    render(<ProductView productId="p1" category="audio" />);
    expect(views()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('W02 AS-67: renders nothing', () => {
    const view = render(<ProductView productId="p1" category="audio" />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
