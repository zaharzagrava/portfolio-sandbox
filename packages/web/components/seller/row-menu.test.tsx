import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RowMenu } from './row-menu';

const items = (onEdit = vi.fn(), onArchive = vi.fn()) => [
  { id: 'edit', label: 'Edit', onSelect: onEdit },
  { id: 'archive', label: 'Archive', onSelect: onArchive, destructive: true },
];

describe('W04 RowMenu', () => {
  it('W04 AS-94: the trigger name includes its row, and it opens with Enter or Space', async () => {
    const user = userEvent.setup();
    render(<RowMenu label="Handmade Ceramic Mug" items={items()} />);
    const trigger = screen.getByRole('button', { name: 'Actions for Handmade Ceramic Mug' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    await user.keyboard(' ');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('W04 AS-94: arrow keys move through the items and Enter chooses one', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(<RowMenu label="Mug" items={items(vi.fn(), onArchive)} />);
    screen.getByRole('button', { name: 'Actions for Mug' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onArchive).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('W04 AS-42: no visible item means no menu at all (a viewer sees no action column control)', () => {
    const { container, rerender } = render(<RowMenu label="Mug" items={[{ id: 'edit', label: 'Edit', onSelect: vi.fn(), hidden: true }]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RowMenu label="Mug" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('W04 AS-86: with a read-only reason every item is disabled and the reason is read with the menu', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<RowMenu label="Mug" items={items(onEdit)} disabledReason="This shop is suspended. You can view data but not make changes." />);
    await user.click(screen.getByRole('button', { name: 'Actions for Mug' }));
    expect(await screen.findByText('This shop is suspended. You can view data but not make changes.')).toBeInTheDocument();
    for (const item of screen.getAllByRole('menuitem')) expect(item).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('W04 AS-94: a disabled item cannot be chosen, a hidden one is not offered', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      <RowMenu
        label="Mug"
        items={[
          { id: 'edit', label: 'Edit', onSelect: onEdit, disabled: true },
          { id: 'restore', label: 'Restore', onSelect: vi.fn(), hidden: true },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Actions for Mug' }));
    expect(screen.queryByRole('menuitem', { name: 'Restore' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(onEdit).not.toHaveBeenCalled();
  });
});
