'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { roundCoords, type Coords } from '@/lib/pickup/coords';
import { LOCATION_MESSAGES } from '@/lib/pickup/location-copy';

export type LocationStatus = 'idle' | 'asking' | 'granted' | 'denied' | 'unsupported' | 'timeout' | 'unavailable';

const OPTIONS: PositionOptions = { timeout: 10_000, maximumAge: 300_000, enableHighAccuracy: false };

const MESSAGES: Partial<Record<LocationStatus, string>> = {
  denied: LOCATION_MESSAGES.denied,
  unsupported: LOCATION_MESSAGES.unsupported,
  timeout: LOCATION_MESSAGES.failed,
  unavailable: LOCATION_MESSAGES.failed,
};

/**
 * The one shared location hook (W02 FR-041, FR-043): asks only when `request()` is called (a user action), never on load.
 * Coordinates are rounded to three decimals when they are written and live in this hook's state only. The browser's own
 * error text is not kept.
 */
export function useBrowserLocation() {
  const [status, setStatus] = useState<LocationStatus>('idle');
  const [coords, setCoords] = useState<Coords | null>(null);
  const mounted = useRef(true);
  const asking = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = useCallback(() => {
    if (asking.current) return;
    const geolocation = typeof navigator === 'undefined' ? undefined : navigator.geolocation;
    if (!geolocation || typeof window === 'undefined' || window.isSecureContext === false) {
      setStatus('unsupported');
      return;
    }
    asking.current = true;
    setStatus('asking');
    setCoords(null);
    geolocation.getCurrentPosition(
      (position) => {
        asking.current = false;
        if (!mounted.current) return;
        setCoords(roundCoords({ lat: position.coords.latitude, lng: position.coords.longitude }));
        setStatus('granted');
      },
      (error) => {
        asking.current = false;
        if (!mounted.current) return;
        setStatus(error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable');
      },
      OPTIONS,
    );
  }, []);

  return {
    status,
    coords,
    /** The exact text for the current state, or `null` when there is nothing to say. */
    message: status === 'asking' ? null : (MESSAGES[status] ?? null),
    /** Where **Try again** can help. */
    canRetry: status === 'denied' || status === 'timeout' || status === 'unavailable',
    request,
  };
}
