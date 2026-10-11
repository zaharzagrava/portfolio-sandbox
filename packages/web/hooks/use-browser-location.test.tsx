import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATION_MESSAGES } from '@/lib/pickup/location-copy';
import { useBrowserLocation } from './use-browser-location';

type Success = (position: GeolocationPosition) => void;
type Failure = (error: GeolocationPositionError) => void;

const position = (lat: number, lng: number) => ({ coords: { latitude: lat, longitude: lng, accuracy: 10 } }) as GeolocationPosition;
const failure = (code: 1 | 2 | 3) => ({ code, message: `secret ${code}`, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) as GeolocationPositionError;

let pending: { success: Success; failure: Failure; options: PositionOptions | undefined }[] = [];
const getCurrentPosition = vi.fn((success: Success, error?: Failure | null, options?: PositionOptions) => {
  pending.push({ success, failure: error as Failure, options });
});

const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

beforeEach(() => {
  pending = [];
  getCurrentPosition.mockClear();
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});

afterEach(() => {
  if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
  if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
  else Reflect.deleteProperty(window, 'isSecureContext');
});

describe('useBrowserLocation', () => {
  it('W02 AS-29: starts idle and asks for nothing on mount', () => {
    const { result } = renderHook(() => useBrowserLocation());
    expect(result.current.status).toBe('idle');
    expect(result.current.coords).toBeNull();
    expect(result.current.message).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('W02 AS-41: asking happens only on request, with a 10 s timeout, 5 minute cache and no high accuracy', () => {
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    expect(result.current.status).toBe('asking');
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(pending[0].options).toEqual({ timeout: 10_000, maximumAge: 300_000, enableHighAccuracy: false });
  });

  it('W02 AS-31: a granted position is rounded to three decimals and held in memory', () => {
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    act(() => pending[0].success(position(52.520008, 13.404954)));
    expect(result.current.status).toBe('granted');
    expect(result.current.coords).toEqual({ lat: 52.52, lng: 13.405 });
    expect(result.current.message).toBeNull();
    expect(result.current.canRetry).toBe(false);
  });

  it('W02 AS-29: denied shows the exact message and offers Try again', () => {
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    act(() => pending[0].failure(failure(1)));
    expect(result.current.status).toBe('denied');
    expect(result.current.message).toBe('Location is off. Allow location access in your browser to find pickup near you.');
    expect(result.current.message).toBe(LOCATION_MESSAGES.denied);
    expect(result.current.canRetry).toBe(true);
    expect(result.current.coords).toBeNull();
  });

  it('W02 AS-29: timeout shows the exact message and offers Try again', () => {
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    act(() => pending[0].failure(failure(3)));
    expect(result.current.status).toBe('timeout');
    expect(result.current.message).toBe("We couldn't get your location. Try again.");
    expect(result.current.canRetry).toBe(true);
  });

  it('W02 AS-29: position unavailable shows the same message and offers Try again', () => {
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    act(() => pending[0].failure(failure(2)));
    expect(result.current.status).toBe('unavailable');
    expect(result.current.message).toBe("We couldn't get your location. Try again.");
    expect(result.current.canRetry).toBe(true);
  });

  it('W02 AS-29: the browser error text is never shown', () => {
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    act(() => pending[0].failure(failure(2)));
    expect(JSON.stringify(result.current)).not.toContain('secret');
  });

  it('W02 AS-29: a browser without geolocation is unsupported at once, with no Try again and no request', () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    expect(result.current.status).toBe('unsupported');
    expect(result.current.message).toBe("Your browser can't share its location.");
    expect(result.current.canRetry).toBe(false);
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('W02 AS-29: an insecure page is unsupported at once, with the same message and no request', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    expect(result.current.status).toBe('unsupported');
    expect(result.current.message).toBe("Your browser can't share its location.");
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('W02 AS-29: Try again asks again from denied, timeout and unavailable', () => {
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    act(() => pending[0].failure(failure(3)));
    act(() => result.current.request());
    expect(result.current.status).toBe('asking');
    expect(result.current.message).toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
    act(() => pending[1].success(position(1.2344, 2.5666)));
    expect(result.current.coords).toEqual({ lat: 1.234, lng: 2.567 });
  });

  it('W02 AS-41: a second request while asking sends nothing', () => {
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    act(() => result.current.request());
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('W02 AS-31: an answer that arrives after unmount changes nothing and throws nothing', () => {
    const { result, unmount } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    unmount();
    expect(() => pending[0].success(position(1, 2))).not.toThrow();
  });

  it('W02 AS-31: coordinates are never written to storage, cookies or the console', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useBrowserLocation());
    act(() => result.current.request());
    act(() => pending[0].success(position(52.520008, 13.404954)));
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('52.5');
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    setItem.mockRestore();
    log.mockRestore();
    error.mockRestore();
  });
});
