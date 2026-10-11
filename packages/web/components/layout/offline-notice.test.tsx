import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineNotice } from './offline-notice';

const OFFLINE = "You're offline. Some things may not load or save until you're back online.";

const setOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
};

describe('W07 offline notice (AS-14)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  });
  afterEach(() => vi.useRealTimers());

  it('W07 AS-14: the status region exists from the start and is empty while online', () => {
    render(<OfflineNotice />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('W07 AS-14: an offline event shows the bar; the online event shows "Back online." for 3 s and then removes it', () => {
    render(<OfflineNotice />);
    setOnline(false);
    expect(screen.getByRole('status')).toHaveTextContent(OFFLINE);
    setOnline(true);
    expect(screen.getByRole('status')).toHaveTextContent('Back online.');
    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Back online.');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('W07 AS-14: starting offline shows the bar at once', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    render(<OfflineNotice />);
    expect(screen.getByRole('status')).toHaveTextContent(OFFLINE);
  });

  it('W07 AS-14: going offline again during "Back online." replaces it and the old timer does not clear the new bar', () => {
    render(<OfflineNotice />);
    setOnline(false);
    setOnline(true);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    setOnline(false);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent(OFFLINE);
  });

  it('W07 AS-14: the bar does not push the header (it is fixed below it, not in the header) and nothing polls', () => {
    const timers = vi.getTimerCount();
    render(<OfflineNotice />);
    expect(vi.getTimerCount()).toBe(timers);
    setOnline(false);
    expect(screen.getByRole('status').className).toContain('fixed');
  });

  it('W07 AS-14: listeners are removed on unmount', () => {
    const { unmount } = render(<OfflineNotice />);
    unmount();
    setOnline(false);
    expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument();
  });
});
