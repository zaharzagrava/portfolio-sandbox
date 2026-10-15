import { render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/vitest.setup';

const navigation = vi.hoisted(() => ({ pathname: '/products/p1', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

import { RefCapture } from './ref-capture';

const URL = 'http://localhost:3000/api/attribution/ref';
let bodies: unknown[];
let status: number;

beforeEach(() => {
  bodies = [];
  status = 204;
  navigation.pathname = '/products/p1';
  navigation.search = '';
  server.use(
    http.post(URL, async ({ request }) => {
      bodies.push(await request.json());
      return new HttpResponse(null, { status });
    }),
  );
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('RefCapture', () => {
  it('W02 AS-63: a valid ref is sent once, also under the development double mount, and nothing is shown', async () => {
    navigation.search = '?ref=Ab9_-x&tab=pickup';
    const view = render(
      <StrictMode>
        <RefCapture />
      </StrictMode>,
    );
    await settle();
    expect(bodies).toEqual([{ code: 'Ab9_-x' }]);
    expect(view.container).toBeEmptyDOMElement();
  });

  it.each(['', '?ref=', '?ref=a%3Bb', `?ref=${'a'.repeat(65)}`, '?other=1'])('W02 AS-63: %j sends nothing', async (search) => {
    navigation.search = search;
    render(<RefCapture />);
    await settle();
    expect(bodies).toEqual([]);
  });

  it('W02 AS-63: a re-render on the same page view sends nothing more; another code is a new page view', async () => {
    navigation.search = '?ref=first';
    const view = render(<RefCapture />);
    view.rerender(<RefCapture />);
    await settle();
    navigation.search = '?ref=second';
    view.rerender(<RefCapture />);
    await settle();
    expect(bodies).toEqual([{ code: 'first' }, { code: 'second' }]);
  });

  it('W02 AS-63: a failing endpoint or a network error shows nothing and throws nothing', async () => {
    status = 500;
    navigation.search = '?ref=abc';
    const view = render(<RefCapture />);
    await settle();
    expect(bodies).toHaveLength(1);
    expect(view.container).toBeEmptyDOMElement();
    server.use(http.post(URL, () => HttpResponse.error()));
    navigation.search = '?ref=def';
    view.rerender(<RefCapture />);
    await settle();
    expect(view.container).toBeEmptyDOMElement();
  });
});
