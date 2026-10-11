'use client';

import { useEffect, useRef, useState } from 'react';

const FIVE_MINUTES = 300;
const ONE_MINUTE = 60;

/** 0 more than five minutes left, 1 up to five, 2 up to one, 3 over. A tier only ever goes up while the page is open. */
function tierOf(seconds: number): 0 | 1 | 2 | 3 {
  if (seconds <= 0) return 3;
  if (seconds <= ONE_MINUTE) return 2;
  return seconds <= FIVE_MINUTES ? 1 : 0;
}

const ANNOUNCEMENTS: Record<0 | 1 | 2 | 3, string> = {
  0: '',
  1: 'Your reservation ends in 5 minutes',
  2: 'Your reservation ends in 1 minute',
  3: 'Your reservation has ended',
};

const clock = (seconds: number): string => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * The reservation countdown of the pay step (W03 AS-36). `role="timer"` is not a live region, so the seconds are not read
 * out; a separate polite status announces 5 minutes, 1 minute and the end, each once. At zero, with no payment in
 * progress, `onExpired` runs once so the page reads the order again: the server's status, never this clock, decides.
 * While a payment is in progress the countdown is replaced by "Payment in progress" and expiry is neither announced nor
 * acted on. The seconds are first read in an effect, so the server render and the first client render agree.
 */
export function ReservationTimer({ reservedUntil, paymentInProgress, onExpired }: { reservedUntil: string | null; paymentInProgress: boolean; onExpired: () => void }) {
  const deadline = reservedUntil ? Date.parse(reservedUntil) : Number.NaN;
  const [remaining, setRemaining] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const latest = useRef({ paymentInProgress, onExpired });
  useEffect(() => {
    latest.current = { paymentInProgress, onExpired };
  });

  useEffect(() => {
    if (Number.isNaN(deadline)) return;
    let tier: 0 | 1 | 2 | 3 | null = null;
    let expiredSent = false;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(seconds);
      const next = tierOf(seconds);
      const crossed = tier !== null && next > tier;
      tier = next;
      if (latest.current.paymentInProgress) return;
      if (crossed) setAnnouncement(ANNOUNCEMENTS[next]);
      if (seconds === 0 && !expiredSent) {
        expiredSent = true;
        latest.current.onExpired();
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  if (Number.isNaN(deadline)) return null;
  return (
    <div className="space-y-1">
      {paymentInProgress ? (
        <p className="text-sm font-medium">Payment in progress</p>
      ) : (
        <p role="timer" className="text-sm font-medium tabular-nums">
          Items reserved for {remaining === null ? '--:--' : clock(remaining)}
        </p>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
