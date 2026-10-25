import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from './sonner';

const items = () => Array.from(document.querySelectorAll<HTMLElement>('li[data-sonner-toast]'));
const visible = () => items().filter((li) => li.dataset.visible === 'true');
const flush = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('W07 toaster (AS-15)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    act(() => {
      toast.dismiss();
    });
    vi.useRealTimers();
  });

  it('W07 AS-15: one toast area for the whole app', async () => {
    render(<Toaster />);
    act(() => {
      toast('One');
    });
    expect(document.querySelectorAll('section[aria-label^="Notifications"]')).toHaveLength(1);
  });

  it('W07 AS-15: at most 3 toasts are visible at a time', async () => {
    render(<Toaster />);
    act(() => {
      for (const n of [1, 2, 3, 4, 5]) toast.info(`Toast ${n}`, { id: `t${n}` });
    });
    await flush(50);
    expect(items().length).toBeGreaterThanOrEqual(3);
    expect(visible()).toHaveLength(3);
  });

  it('W07 AS-15: politeness per kind - success and info are status, errors are alert', async () => {
    render(<Toaster />);
    act(() => {
      toast.success('Saved');
      toast.info('FYI');
      toast.error('Failed');
    });
    await flush(50);
    // B-102: the role sits on the content inside the list item, so the list keeps only list items
    const byText = (text: string) => items().find((li) => li.textContent?.includes(text))!.querySelector<HTMLElement>('[data-content]')!;
    expect(items().every((li) => !li.hasAttribute('role'))).toBe(true);
    expect(byText('Saved')).toHaveAttribute('role', 'status');
    expect(byText('FYI')).toHaveAttribute('role', 'status');
    expect(byText('Failed')).toHaveAttribute('role', 'alert');
    expect(byText('Failed')).toHaveAttribute('aria-live', 'assertive');
    expect(byText('Saved')).toHaveAttribute('aria-live', 'polite');
  });

  it('W07 AS-15: success and info disappear after 5 s, not before', async () => {
    render(<Toaster />);
    act(() => {
      toast.success('Saved');
    });
    await flush(4_500);
    expect(screen.queryByText('Saved')).toBeInTheDocument();
    await flush(1_500);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('W07 AS-15: auto-dismiss pauses while the toasts are hovered', async () => {
    render(<Toaster />);
    act(() => {
      toast.success('Saved');
    });
    await flush(1_000);
    const area = document.querySelector('ol[data-sonner-toaster]') as HTMLElement;
    fireEvent.mouseEnter(area);
    await flush(20_000);
    expect(screen.queryByText('Saved')).toBeInTheDocument();
    fireEvent.mouseLeave(area);
    await flush(6_000);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('W07 AS-15: error toasts and toasts with an action stay until dismissed', async () => {
    render(<Toaster />);
    act(() => {
      toast.error('Could not save');
      toast.success('Item removed', { action: { label: 'Undo', onClick: () => {} } });
    });
    await flush(60_000);
    expect(screen.queryByText('Could not save')).toBeInTheDocument();
    expect(screen.queryByText('Item removed')).toBeInTheDocument();
  });

  it('W07 AS-15: every toast has a Dismiss button that removes it', async () => {
    render(<Toaster />);
    act(() => {
      toast.error('Could not save');
    });
    await flush(50);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await flush(1_000);
    expect(screen.queryByText('Could not save')).not.toBeInTheDocument();
  });

  it('W07 AS-15: toast text is plain text, never markup', async () => {
    render(<Toaster />);
    act(() => {
      toast.info('<img src=x onerror=alert(1)> <b>bold</b>');
    });
    await flush(50);
    expect(document.querySelector('li[data-sonner-toast] img[src="x"]')).toBeNull();
    expect(document.querySelector('li[data-sonner-toast] b')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> <b>bold</b>')).toBeInTheDocument();
  });
});
