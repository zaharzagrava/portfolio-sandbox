import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { COPY } from '@/lib/auth/copy';
import { LOCATION_MESSAGES } from '@/lib/pickup/location-copy';
import { emptyResponse, PRODUCT_ID, pickupPoint, pickupPointsBody, problemResponse } from '@/lib/test/msw-handlers';
import { PickupPanel } from '@/components/product/pickup-panel';

type Success = (position: GeolocationPosition) => void;
type Failure = (error: GeolocationPositionError) => void;

const position = (lat: number, lng: number) => ({ coords: { latitude: lat, longitude: lng, accuracy: 10 } }) as GeolocationPosition;
const failure = (code: 1 | 2 | 3) => ({ code, message: `secret ${code}` }) as GeolocationPositionError;

const getCurrentPosition = vi.fn();
const answerWith = (answer: GeolocationPosition | GeolocationPositionError) =>
  getCurrentPosition.mockImplementation((ok: Success, fail: Failure) => {
    if ('coords' in answer) ok(answer);
    else fail(answer);
  });

const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

beforeEach(() => {
  getCurrentPosition.mockReset();
  answerWith(position(52.520008, 13.404954));
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  requests.length = 0;
});
afterEach(() => {
  if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
  if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
  else Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});

const requests: URL[] = [];
const answerPoints = (handler: (url: URL) => Response | Promise<Response> = () => HttpResponse.json(pickupPointsBody())) =>
  server.use(
    http.get('*/api/pickup-points/near', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return handler(url);
    }),
  );

function setup() {
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }));
  render(
    <QueryClientProvider client={client}>
      <PickupPanel productId={PRODUCT_ID} />
    </QueryClientProvider>,
  );
  return { client, user: userEvent.setup() };
}

const useLocation = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Use my location' }));

describe('PickupPanel', () => {
  it('W02 AS-41: idle shows the intro and Use my location and makes no request and no location prompt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setup();
    expect(screen.getByText('See which pickup points near you have this product.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('W02 AS-43: asking shows "Getting your location…" as a busy status', async () => {
    getCurrentPosition.mockImplementation(() => undefined);
    const { user } = setup();
    await useLocation(user);
    const status = screen.getByText(LOCATION_MESSAGES.asking);
    expect(status).toBeInTheDocument();
    expect(status.closest('[aria-busy="true"]')).not.toBeNull();
  });

  it('W02 AS-41: a granted position lists the points the API gave, nearest first, with name, address, distance, quantity and status', async () => {
    answerPoints(() =>
      HttpResponse.json(
        pickupPointsBody([
          pickupPoint(1, { name: 'Mitte Locker', address: '1 Example Street, Berlin', distanceM: 850, quantity: 3, openingHours: {} }),
          pickupPoint(2, { name: 'Far Locker', address: '2 Example Street, Berlin', distanceM: 2400, quantity: 1, openingHours: {} }),
        ]),
      ),
    );
    const { user } = setup();
    await useLocation(user);
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('heading', { name: 'Mitte Locker' })).toBeInTheDocument();
    expect(within(items[0]!).getByText('1 Example Street, Berlin')).toBeInTheDocument();
    expect(within(items[0]!).getByText('850 m')).toBeInTheDocument();
    expect(within(items[0]!).getByText('3 available')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Hours not provided')).toBeInTheDocument();
    expect(within(items[1]!).getByText('2.4 km')).toBeInTheDocument();
    const params = Object.fromEntries(requests[0]!.searchParams);
    expect(params).toEqual({ lat: '52.52', lng: '13.405', radiusKm: '5', productId: PRODUCT_ID, limit: '10' });
    expect(screen.getByRole('combobox', { name: 'Radius' })).toHaveValue('5');
  });

  it("W02 AS-41: the opening status is computed in the point's own time zone", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T08:30:00Z')); // Monday 10:30 in Berlin
    try {
      answerPoints(() =>
        HttpResponse.json(pickupPointsBody([pickupPoint(1, { openingHours: { timezone: 'Europe/Berlin', weekly: { mon: [{ open: '09:00', close: '18:00' }], tue: [{ open: '09:00', close: '18:00' }] } } })])),
      );
      const { user } = setup();
      await useLocation(user);
      expect(await screen.findByText('Open now · closes 18:00')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('W02 AS-41: a point without a quantity shows none', async () => {
    answerPoints(() => HttpResponse.json(pickupPointsBody([pickupPoint(1, { quantity: undefined })])));
    const { user } = setup();
    await useLocation(user);
    await screen.findByRole('heading', { name: 'Point 1' });
    expect(screen.queryByText(/available/)).not.toBeInTheDocument();
  });

  it.each([
    ['denied', failure(1), LOCATION_MESSAGES.denied],
    ['timeout', failure(3), LOCATION_MESSAGES.failed],
    ['unavailable', failure(2), LOCATION_MESSAGES.failed],
  ])('W02 AS-43: location %s shows the AS-29 message with Try again and sends no request', async (_name, error, message) => {
    answerWith(error);
    answerPoints();
    const { user } = setup();
    await useLocation(user);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('W02 AS-43: an unsupported browser says so without Try again', async () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    answerPoints();
    const { user } = setup();
    await useLocation(user);
    expect(await screen.findByText(LOCATION_MESSAGES.unsupported)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('W02 AS-43: Try again after a denial asks again and lists the points', async () => {
    answerWith(failure(1));
    answerPoints();
    const { user } = setup();
    await useLocation(user);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    answerWith(position(52.52, 13.405));
    await user.click(retry);
    expect(await screen.findByRole('heading', { name: 'Point 1' })).toBeInTheDocument();
  });

  it('W02 AS-43: an empty answer names the radius and offers the radius control', async () => {
    answerPoints(() => HttpResponse.json(pickupPointsBody([])));
    const { user } = setup();
    await useLocation(user);
    expect(await screen.findByText('No pickup point within 5 km has this product. Try a larger radius.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Radius' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show 10 more' })).not.toBeInTheDocument();
  });

  it('W02 AS-43: 429 shows the wait', async () => {
    answerPoints(() => problemResponse(429, 'rate_limited', { retryAfter: 30 }));
    const { user } = setup();
    await useLocation(user);
    expect(await screen.findByText('Too many requests. Try again in 30 seconds.')).toBeInTheDocument();
  });

  it('W02 AS-43: 5xx and 503 show the temporary failure with Try again and the reference', async () => {
    answerPoints(() => problemResponse(503, 'search_unavailable', { requestId: 'req-77' }));
    const { user } = setup();
    await useLocation(user);
    expect(await screen.findByText('Pickup availability is temporarily unavailable. Try again.')).toBeInTheDocument();
    expect(screen.getByText('req-77')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('W02 AS-43: an answer without a body is the same temporary failure', async () => {
    answerPoints(() => emptyResponse(500));
    const { user } = setup();
    await useLocation(user);
    expect(await screen.findByText('Pickup availability is temporarily unavailable. Try again.')).toBeInTheDocument();
  });

  it('W02 AS-43: no network shows the offline copy', async () => {
    answerPoints(() => HttpResponse.error());
    const { user } = setup();
    await useLocation(user);
    expect(await screen.findByText(COPY.offline)).toBeInTheDocument();
  });

  it('W02 AS-44: the radius offers 1, 2, 5, 10, 20, 50 km and a change refetches from the first page', async () => {
    answerPoints((url) => HttpResponse.json(pickupPointsBody([pickupPoint(url.searchParams.get('radiusKm') === '20' ? 9 : 1)], url.searchParams.get('radiusKm') === '5' ? 'cur-2' : null)));
    const { user } = setup();
    await useLocation(user);
    await screen.findByRole('heading', { name: 'Point 1' });
    const radius = screen.getByRole('combobox', { name: 'Radius' });
    expect(within(radius).getAllByRole('option').map((option) => option.textContent)).toEqual(['1 km', '2 km', '5 km', '10 km', '20 km', '50 km']);
    await user.selectOptions(radius, '20');
    expect(await screen.findByRole('heading', { name: 'Point 9' })).toBeInTheDocument();
    const last = requests.at(-1)!.searchParams;
    expect(last.get('radiusKm')).toBe('20');
    expect(last.has('cursor')).toBe(false);
    expect(window.location.search).not.toMatch(/radius/); // the choice is not in the address
    expect(screen.queryByRole('heading', { name: 'Point 1' })).not.toBeInTheDocument();
  });

  it('W02 AS-44: Show 10 more appends the next page without duplicates and moves focus to the first added item', async () => {
    const first = Array.from({ length: 10 }, (_, index) => pickupPoint(index + 1));
    const second = [pickupPoint(10), pickupPoint(11), pickupPoint(12)]; // 10 repeats
    answerPoints((url) => HttpResponse.json(url.searchParams.get('cursor') === 'cur-2' ? pickupPointsBody(second, null) : pickupPointsBody(first, 'cur-2')));
    const { user } = setup();
    await useLocation(user);
    await screen.findByRole('heading', { name: 'Point 1' });
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'Show 10 more' }));
    await screen.findByRole('heading', { name: 'Point 12' });
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getAllByRole('heading', { name: 'Point 10' })).toHaveLength(1);
    expect(requests.at(-1)!.searchParams.get('cursor')).toBe('cur-2');
    await waitFor(() => expect(screen.getAllByRole('listitem')[10]).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Show 10 more' })).not.toBeInTheDocument();
  });

  it('W02 AS-44: the button is absent when there is no nextCursor', async () => {
    answerPoints(() => HttpResponse.json(pickupPointsBody([pickupPoint(1)], null)));
    const { user } = setup();
    await useLocation(user);
    await screen.findByRole('heading', { name: 'Point 1' });
    expect(screen.queryByRole('button', { name: 'Show 10 more' })).not.toBeInTheDocument();
  });

  it('W02 AS-42: nothing for the map is requested before Show map; then the map region opens and Close returns focus to the button', async () => {
    answerPoints();
    let clusterRequests = 0;
    server.use(
      http.get('*/api/pickup-points/clusters', () => {
        clusterRequests += 1;
        return HttpResponse.json({ cells: [], truncated: false });
      }),
    );
    const { user } = setup();
    await useLocation(user);
    await screen.findByRole('heading', { name: 'Point 1' });
    expect(screen.queryByRole('region', { name: 'Pickup map' })).not.toBeInTheDocument();
    expect(clusterRequests).toBe(0);
    const show = screen.getByRole('button', { name: 'Show map' });
    await user.click(show);
    expect(await screen.findByRole('region', { name: 'Pickup map' })).toBeInTheDocument();
    await waitFor(() => expect(clusterRequests).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Pickup map' })).not.toBeInTheDocument();
    expect(show).toHaveFocus();
  });

  it('W02 AS-77: nothing reaches the console with coordinates', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    answerPoints(() => problemResponse(503, 'search_unavailable'));
    const { user } = setup();
    await useLocation(user);
    await screen.findByText('Pickup availability is temporarily unavailable. Try again.');
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toMatch(/52\.52|13\.40/);
  });
});
