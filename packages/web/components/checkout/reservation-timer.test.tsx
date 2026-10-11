import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReservationTimer } from './reservation-timer';

const START = new Date('2026-10-11T10:00:00.000Z');
const endsIn = (seconds: number) => new Date(START.getTime() + seconds * 1000).toISOString();
const tick = (seconds: number) => act(() => vi.advanceTimersByTime(seconds * 1000));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

describe('Reservation timer', () => {
  it('W03 AS-36: shows "Items reserved for mm:ss" in an element with role timer, counting down', () => {
    render(<ReservationTimer reservedUntil={endsIn(15 * 60)} paymentInProgress={false} onExpired={vi.fn()} />);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('Items reserved for 15:00');
    tick(1);
    expect(timer).toHaveTextContent('Items reserved for 14:59');
    tick(59);
    expect(timer).toHaveTextContent('Items reserved for 14:00');
    tick(9 * 60 + 55);
    expect(timer).toHaveTextContent('Items reserved for 04:05');
  });

  it('W03 AS-36: the countdown itself is not read out every second (the timer is not a live region)', () => {
    render(<ReservationTimer reservedUntil={endsIn(600)} paymentInProgress={false} onExpired={vi.fn()} />);
    const timer = screen.getByRole('timer');
    expect(timer).not.toHaveAttribute('aria-live', 'polite');
    expect(timer).not.toHaveAttribute('aria-live', 'assertive');
    expect(timer.closest('[aria-live="polite"], [role="status"], [role="alert"]')).toBeNull();
  });

  it('W03 AS-36: a polite status announces 5 minutes, 1 minute and the end, each once', () => {
    render(<ReservationTimer reservedUntil={endsIn(6 * 60)} paymentInProgress={false} onExpired={vi.fn()} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('');

    tick(59);
    expect(status).toHaveTextContent('');
    tick(1); // 5:00 left
    expect(status).toHaveTextContent('Your reservation ends in 5 minutes');

    tick(30);
    expect(status).toHaveTextContent('Your reservation ends in 5 minutes');
    tick(3 * 60 + 30); // 1:00 left
    expect(status).toHaveTextContent('Your reservation ends in 1 minute');
    expect(status).not.toHaveTextContent('5 minutes');

    tick(59);
    expect(status).toHaveTextContent('Your reservation ends in 1 minute');
    tick(1); // 0:00
    expect(status).toHaveTextContent('Your reservation has ended');
  });

  it('W03 AS-36: at zero with no payment in progress the order is re-read, once', () => {
    const onExpired = vi.fn();
    render(<ReservationTimer reservedUntil={endsIn(3)} paymentInProgress={false} onExpired={onExpired} />);
    tick(2);
    expect(onExpired).not.toHaveBeenCalled();
    tick(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
    tick(30);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('timer')).toHaveTextContent('Items reserved for 00:00');
  });

  it('W03 AS-36: a reservation already over when the page opens is re-read at once', () => {
    const onExpired = vi.fn();
    render(<ReservationTimer reservedUntil={endsIn(-30)} paymentInProgress={false} onExpired={onExpired} />);
    tick(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-36: "Payment in progress" replaces the countdown and expiry is neither announced nor re-read', () => {
    const onExpired = vi.fn();
    render(<ReservationTimer reservedUntil={endsIn(90)} paymentInProgress onExpired={onExpired} />);
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.getByText('Payment in progress')).toBeInTheDocument();
    tick(60); // 0:30 left
    tick(120); // past the end
    expect(onExpired).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.queryByText(/reservation has ended/i)).not.toBeInTheDocument();
  });

  it('W03 AS-36: a payment that starts before zero stops the expiry announcement and the re-read', () => {
    const onExpired = vi.fn();
    const { rerender } = render(<ReservationTimer reservedUntil={endsIn(100)} paymentInProgress={false} onExpired={onExpired} />);
    tick(40);
    rerender(<ReservationTimer reservedUntil={endsIn(100)} paymentInProgress onExpired={onExpired} />);
    tick(120);
    expect(onExpired).not.toHaveBeenCalled();
    expect(screen.queryByText(/reservation has ended/i)).not.toBeInTheDocument();
  });

  it('W03 AS-36: no deadline (null) renders nothing and never calls onExpired', () => {
    const onExpired = vi.fn();
    const { container } = render(<ReservationTimer reservedUntil={null} paymentInProgress={false} onExpired={onExpired} />);
    tick(1000);
    expect(container).toBeEmptyDOMElement();
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('W03 AS-36: the interval is cleared on unmount', () => {
    const onExpired = vi.fn();
    const { unmount } = render(<ReservationTimer reservedUntil={endsIn(5)} paymentInProgress={false} onExpired={onExpired} />);
    unmount();
    tick(60);
    expect(onExpired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
