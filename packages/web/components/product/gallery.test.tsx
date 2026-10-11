import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Gallery, type GalleryImage } from '@/components/product/gallery';

const image = (n: number, host = 'https://m.example'): GalleryImage => ({
  mediaId: `5f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a0${n}`,
  urls: { thumb: `${host}/${n}-t.jpg`, feed: `${host}/${n}-f.jpg`, full: `${host}/${n}-F.jpg` },
  width: 800,
  height: 600,
});

const three = [image(1), image(2), image(3)];

describe('Gallery', () => {
  it('W02 AS-36: the main image is the first item at feed size, with the title as alt text, loaded eagerly', () => {
    render(<Gallery items={three} title="Espresso machine" />);
    const main = screen.getByRole('img', { name: 'Espresso machine' });
    expect(main).toHaveAttribute('src', 'https://m.example/1-f.jpg');
    expect(main).toHaveAttribute('loading', 'eager');
  });

  it('W02 AS-36: thumbnails are buttons named "Show image n of total"; the shown one has aria-current', async () => {
    const user = userEvent.setup();
    const { container } = render(<Gallery items={three} title="Espresso machine" />);
    const buttons = screen.getAllByRole('button', { name: /^Show image/ });
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Show image 1 of 3', 'Show image 2 of 3', 'Show image 3 of 3']);
    expect(buttons[0]).toHaveAttribute('aria-current', 'true');
    expect(buttons[1]).not.toHaveAttribute('aria-current');
    await user.click(buttons[1]!);
    expect(screen.getByRole('img', { name: 'Espresso machine' })).toHaveAttribute('src', 'https://m.example/2-f.jpg');
    expect(buttons[1]).toHaveAttribute('aria-current', 'true');
    expect(buttons[0]).not.toHaveAttribute('aria-current');
    // thumbnails use the thumb size, are decorative, and the others load lazily
    const thumbs = container.querySelectorAll('[aria-label^="Show image"] img');
    expect(thumbs[0]).toHaveAttribute('src', 'https://m.example/1-t.jpg');
    expect(thumbs[0]).toHaveAttribute('alt', '');
    expect(thumbs[1]).toHaveAttribute('loading', 'lazy');
  });

  it('W02 AS-36: a single image has no thumbnails', () => {
    render(<Gallery items={[image(1)]} title="One" />);
    expect(screen.queryByRole('button', { name: /^Show image/ })).toBeNull();
  });

  it('W02 AS-36: the full size opens in a lightbox that closes with Escape and returns focus', async () => {
    const user = userEvent.setup();
    render(<Gallery items={three} title="Espresso machine" />);
    const opener = screen.getByRole('button', { name: 'Open full size image' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Espresso machine' })).toHaveAttribute('src', 'https://m.example/1-F.jpg');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('W02 AS-36: no gallery gives the neutral placeholder of the same size, and no image', () => {
    const { container } = render(<Gallery items={null} title="Espresso machine" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('gallery-placeholder')).toHaveClass('aspect-square');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('W02 AS-36: an empty gallery is the placeholder', () => {
    render(<Gallery items={[]} title="x" />);
    expect(screen.getByTestId('gallery-placeholder')).toBeInTheDocument();
  });

  it('W02 AS-36: a failing image is replaced by the placeholder', () => {
    render(<Gallery items={[image(1)]} title="Espresso machine" />);
    fireEvent.error(screen.getByRole('img', { name: 'Espresso machine' }));
    expect(screen.queryByRole('img', { name: 'Espresso machine' })).toBeNull();
    expect(screen.getByTestId('gallery-placeholder')).toBeInTheDocument();
  });

  it('W02 AS-72: an item whose address is not https is ignored', () => {
    render(<Gallery items={[image(1, 'http://evil.example'), image(2)]} title="Espresso machine" />);
    expect(screen.getByRole('img', { name: 'Espresso machine' })).toHaveAttribute('src', 'https://m.example/2-f.jpg');
    expect(screen.queryByRole('button', { name: /^Show image/ })).toBeNull();
  });

  it('W02 AS-36: the image box reserves its aspect ratio', () => {
    render(<Gallery items={three} title="Espresso machine" />);
    expect(screen.getByTestId('gallery-main')).toHaveClass('aspect-square');
  });
});
