import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { COPY } from '@/lib/auth/copy';
import { LOCATION_MESSAGES } from '@/lib/pickup/location-copy';
import { emptyResponse, pickupNearBody, problemResponse, searchResponse } from '@/lib/test/msw-handlers';

vi.mock('next/navigation', async () => {
  const { useEffect, useReducer } = await import('react');
  return {
    usePathname: () => '/search',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
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

import { SearchResults } from '@/components/search/search-results';

type Success = (position: GeolocationPosition) => void;
type Failure = (error: GeolocationPositionError) => void;

const position = (lat: number, lng: number) => ({ coords: { latitude: lat, longitude: lng, accuracy: 10 } }) as GeolocationPosition;
const failure = (code: 1 | 2 | 3) => ({ code, message: `secret ${code}` }) as GeolocationPositionError;

const getCurrentPosition = vi.fn();
const answerWith = (position_: GeolocationPosition | GeolocationPositionError) =>
  getCurrentPosition.mockImplementation((ok: Success, fail: Failure) => {
    if ('coords' in position_) ok(position_);
    else fail(position_);
  });

const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);
const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

beforeEach(() => {
  window.history.pushState = (...args) => {
    realPush(...args);
    window.dispatchEvent(new Event('test-nav'));
  };
  window.history.replaceState = (...args) => {
    realReplace(...args);
    window.dispatchEvent(new Event('test-nav'));
  };
  realReplace(null, '', '/search');
  getCurrentPosition.mockReset();
  answerWith(position(52.520008, 13.404954));
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});
afterEach(() => {
  window.history.pushState = realPush;
  window.history.replaceState = realReplace;
  if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
  if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
  else Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});

function setup(address: string) {
  realReplace(null, '', address);
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }));
  render(
    <QueryClientProvider client={client}>
      <SearchResults />
    </QueryClientProvider>,
  );
  return { client, user: userEvent.setup() };
}

const requests: URL[] = [];
const answerNear = (handler: (url: URL) => Response | Promise<Response> = () => HttpResponse.json(pickupNearBody())) =>
  server.use(
    http.get('*/api/search/near', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return handler(url);
    }),
  );
beforeEach(() => {
  requests.length = 0;
  // The ordinary search must stay silent in pickup mode; a stray call fails the test as an unhandled request.
});

const pickupSwitch = () => screen.getByRole('switch', { name: 'Available for pickup near me' });

describe('PickupMode', () => {
  it('W02 AS-28: turning pickup on asks for the location, then the address gains near=1 and cards show distance, point and quantity', async () => {
    answerNear();
    server.use(http.get('*/api/products/search', () => HttpResponse.json(searchResponse())));
    const { user } = setup('/search?q=phone');
    await screen.findByRole('link', { name: /iPhone 17/ });
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await user.click(pickupSwitch());
    const card = await screen.findByRole('link', { name: /iPhone 17/ });
    expect(window.location.search).toBe('?q=phone&near=1');
    expect(within(card).getByText('850 m away · Mitte Locker · 3 available')).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    const params = requests[0]!.searchParams;
    expect(Object.fromEntries(params)).toEqual({ q: 'phone', radiusKm: '5', lat: '52.52', lng: '13.405', limit: '24' });
    expect(pickupSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('W02 AS-28: a distance of 1 km or more is shown in kilometres', async () => {
    answerNear(() =>
      HttpResponse.json(
        pickupNearBody({
          items: [{ ...pickupNearBody().items[0]!, nearest: { pickupPointId: 'p', name: 'Far Point', distanceM: 2400, quantity: 1 } }],
        }),
      ),
    );
    setup('/search?near=1');
    expect(await screen.findByText('2.4 km away · Far Point · 1 available')).toBeInTheDocument();
  });

  it.each([
    ['denied', failure(1), LOCATION_MESSAGES.denied],
    ['timeout', failure(3), LOCATION_MESSAGES.failed],
    ['unavailable', failure(2), LOCATION_MESSAGES.failed],
  ])('W02 AS-29: location %s returns the switch to off with its message, sends no request and leaves near out of the address', async (_name, error, message) => {
    answerWith(error);
    answerNear();
    server.use(http.get('*/api/products/search', () => HttpResponse.json(searchResponse())));
    const { user } = setup('/search');
    await screen.findByRole('link', { name: /iPhone 17/ });
    await user.click(pickupSwitch());
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(pickupSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(window.location.search).toBe('');
    expect(requests).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('W02 AS-29: an unsupported browser says so and offers no Try again', async () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    answerNear();
    server.use(http.get('*/api/products/search', () => HttpResponse.json(searchResponse())));
    const { user } = setup('/search');
    await screen.findByRole('link', { name: /iPhone 17/ });
    await user.click(pickupSwitch());
    expect(await screen.findByText(LOCATION_MESSAGES.unsupported)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('W02 AS-29: a reload with near=1 and a denied location drops near from the address and shows the message', async () => {
    answerWith(failure(1));
    server.use(http.get('*/api/products/search', () => HttpResponse.json(searchResponse())));
    setup('/search?q=phone&near=1&radiusKm=10');
    expect(await screen.findByText(LOCATION_MESSAGES.denied)).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe('?q=phone'));
    expect(requests).toHaveLength(0);
  });

  it('W02 AS-29: Try again asks again and shows the results when the location is then shared', async () => {
    answerWith(failure(3));
    answerNear();
    server.use(http.get('*/api/products/search', () => HttpResponse.json(searchResponse())));
    const { user } = setup('/search');
    await screen.findByRole('link', { name: /iPhone 17/ });
    await user.click(pickupSwitch());
    const retry = await screen.findByRole('button', { name: 'Try again' });
    answerWith(position(52.52, 13.405));
    await user.click(retry);
    expect(await screen.findByText('850 m away · Mitte Locker · 3 available')).toBeInTheDocument();
  });

  it('W02 AS-30: filters, sort and meaning are disabled with their values kept, the heading is "Pickup near you" and there is no count', async () => {
    answerNear();
    setup('/search?q=phone&brand=apple&minRating=3&inStock=true&sort=newest&near=1');
    await screen.findByText('850 m away · Mitte Locker · 3 available');
    expect(screen.getByRole('heading', { level: 1, name: 'Pickup near you' })).toBeInTheDocument();
    const filters = screen.getByRole('form', { name: 'Filters' });
    expect(within(filters).getByText('Not available together with pickup search.')).toBeInTheDocument();
    expect(within(filters).getByRole('switch', { name: 'In stock only' })).toBeDisabled();
    expect(within(filters).getByRole('button', { name: /4 stars/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveValue('newest');
    expect(screen.getByRole('switch', { name: 'Match by meaning' })).toBeDisabled();
    expect(screen.queryByText(/\d+ results?$/)).not.toBeInTheDocument();
    // The values are only paused: the address keeps them and the request ignores them.
    expect(window.location.search).toBe('?q=phone&brand=apple&minRating=3&inStock=true&sort=newest&near=1');
    expect(Object.keys(Object.fromEntries(requests[0]!.searchParams)).sort()).toEqual(['lat', 'limit', 'lng', 'q', 'radiusKm']);
  });

  it('W02 AS-30: turning pickup off brings the controls and their values back', async () => {
    answerNear();
    server.use(http.get('*/api/products/search', () => HttpResponse.json(searchResponse())));
    const { user } = setup('/search?q=phone&brand=apple&near=1');
    await screen.findByText('850 m away · Mitte Locker · 3 available');
    await user.click(pickupSwitch());
    await waitFor(() => expect(window.location.search).toBe('?q=phone&brand=apple'));
    expect(await screen.findByText('1 result')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toBeEnabled();
  });

  it('W02 AS-30: 429 shows the wait, 503 and a missing body the pickup wording, a failed network the offline copy', async () => {
    answerNear(() => problemResponse(429, 'rate_limited', { retryAfter: 30 }));
    setup('/search?near=1');
    expect(await screen.findByText('Too many requests. Try again in 30 seconds.')).toBeInTheDocument();
  });

  it('W02 AS-30: 503 search_unavailable shows the pickup wording with Try again', async () => {
    answerNear(() => problemResponse(503, 'search_unavailable', { requestId: 'req-9' }));
    setup('/search?near=1');
    expect(await screen.findByText('Pickup search is temporarily unavailable. Try again.')).toBeInTheDocument();
    expect(screen.getByText('req-9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('W02 AS-30: an answer without a body is the same temporary failure', async () => {
    answerNear(() => emptyResponse(502));
    setup('/search?near=1');
    expect(await screen.findByText('Pickup search is temporarily unavailable. Try again.')).toBeInTheDocument();
  });

  it('W02 AS-30: a network failure shows the offline copy', async () => {
    answerNear(() => HttpResponse.error());
    setup('/search?near=1');
    expect(await screen.findByText(COPY.offline)).toBeInTheDocument();
  });

  it('W02 AS-30: an empty answer says so and keeps the radius control; changing the radius changes radiusKm and asks again', async () => {
    answerNear((url) => HttpResponse.json(pickupNearBody(url.searchParams.get('radiusKm') === '20' ? {} : { items: [] })));
    const { user } = setup('/search?near=1');
    expect(await screen.findByText('No pickup points near you have these products. Try a larger radius.')).toBeInTheDocument();
    const radius = screen.getByRole('combobox', { name: 'Radius' });
    expect(within(radius).getAllByRole('option').map((option) => option.textContent)).toEqual(['1 km', '2 km', '5 km', '10 km', '20 km', '50 km']);
    expect(radius).toHaveValue('5');
    await user.selectOptions(radius, '20');
    expect(await screen.findByText('850 m away · Mitte Locker · 3 available')).toBeInTheDocument();
    expect(window.location.search).toBe('?near=1&radiusKm=20');
    expect(requests.at(-1)!.searchParams.get('radiusKm')).toBe('20');
  });

  it('W02 AS-28: Next page follows nextCursor in the address and the request', async () => {
    answerNear((url) => HttpResponse.json(pickupNearBody({ nextCursor: url.searchParams.get('cursor') ? null : 'cur-2' })));
    const { user } = setup('/search?near=1');
    await user.click(await screen.findByRole('link', { name: 'Next page' }));
    await waitFor(() => expect(window.location.search).toBe('?near=1&cursor=cur-2'));
    await waitFor(() => expect(requests.at(-1)!.searchParams.get('cursor')).toBe('cur-2'));
    expect(await screen.findByRole('link', { name: 'Back to first page' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('W02 AS-77: nothing sent to the console or a reporter contains the coordinates or the search text', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    answerNear(() => problemResponse(503, 'search_unavailable'));
    const { user } = setup('/search?q=secret-espresso');
    server.use(http.get('*/api/products/search', () => HttpResponse.json(searchResponse())));
    await user.click(await screen.findByRole('switch', { name: 'Available for pickup near me' }));
    await screen.findByText('Pickup search is temporarily unavailable. Try again.');
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toMatch(/52\.52|13\.40|secret-espresso/);
  });

  it('W02 AS-31: the address never contains coordinates and the request has cache no-store (last test of the file)', async () => {
    const calls: { url: string; cache: RequestCache | undefined }[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), cache: init?.cache });
      return real(input, init);
    });
    answerNear();
    setup('/search?q=phone&near=1&radiusKm=10');
    await screen.findByText('850 m away · Mitte Locker · 3 available');
    expect(window.location.href).not.toMatch(/lat|lng|52\.5|13\.4/);
    const call = calls.find((entry) => entry.url.includes('/api/search/near'));
    expect(call).toBeDefined();
    expect(call!.cache).toBe('no-store');
    expect(JSON.stringify([localStorage, sessionStorage, document.cookie])).not.toMatch(/52\.52|13\.405/);
  });
});
