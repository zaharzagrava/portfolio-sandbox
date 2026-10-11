'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  eventForServer,
  initialPayState,
  payReducer,
  serverView,
  type PayEventType,
  type PayPhase,
  type PayServerData,
  type PayServerView,
} from '@/lib/checkout/pay-flow';

export const CONFIRMING_HINT_MS = 60_000;

/**
 * The pay step's phase (FR-051, AS-71): a `useReducer` over the pure reducer of `lib/checkout/pay-flow.ts`, started from the
 * server data the page loaded with. `sync(data)` feeds fresh order/payment data in; `send(event)` is for the buyer's own
 * steps. `slowConfirming` turns true after 60 s in `confirming` (AS-46).
 */
export function usePayFlow(initial: PayServerData): {
  phase: PayPhase;
  view: PayServerView;
  send: (type: PayEventType) => void;
  sync: (data: PayServerData) => void;
  slowConfirming: boolean;
} {
  const [state, dispatch] = useReducer(payReducer, initial, initialPayState);
  const [latest, setLatest] = useState(initial);
  const [slowConfirming, setSlow] = useState(false);

  const phase = state.phase;
  const send = useCallback((type: PayEventType) => dispatch({ type }), []);
  const sync = useCallback(
    (data: PayServerData) => {
      setLatest(data);
      const event = eventForServer(phase, data);
      if (event) dispatch({ type: event });
    },
    [phase],
  );

  useEffect(() => {
    if (phase !== 'confirming') return;
    const timer = setTimeout(() => setSlow(true), CONFIRMING_HINT_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [phase]);

  const view = useMemo(() => serverView(latest), [latest]);
  return { phase, view, send, sync, slowConfirming };
}
