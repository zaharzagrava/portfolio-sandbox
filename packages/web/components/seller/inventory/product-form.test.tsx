import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '../../../vitest.setup';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID, sellerProblem } from '@/lib/test/seller-handlers';
import { productMemberFixture } from '@/lib/test/seller-inventory-fixtures';
import { ProductForm } from './product-form';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const products = `${origin}/api/shops/${SELLER_SHOP_ID}/products`;

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const createForm = (onSaved = vi.fn(), currency = 'EUR', fractionDigits = 2) =>
  wrap(<ProductForm mode="create" shopId={SELLER_SHOP_ID} currency={currency} fractionDigits={fractionDigits} onSaved={onSaved} />);

async function fillRequired(user: ReturnType<typeof userEvent.setup>, price = '24.50') {
  await user.type(screen.getByLabelText('Title'), 'Handmade Ceramic Mug');
  await user.type(screen.getByLabelText('Brand'), 'Clay Works');
  await user.type(screen.getByLabelText('Category'), 'kitchen');
  await user.type(screen.getByLabelText(/^Price/), price);
}

beforeEach(() => vi.clearAllMocks());

describe('W04 product form (create)', () => {
  it('W04 AS-34: the form refuses empty required fields and a bad price itself, with no request, and focuses the first one', async () => {
    const user = userEvent.setup();
    createForm();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create product' }));
    expect(screen.getByLabelText('Title')).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(/fix the/i);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a title.');
    expect(screen.getAllByText('Enter a title.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Enter a brand.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Enter a category.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Enter a price.').length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText(/^Price/), '0.001');
    expect(screen.getAllByText('Use at most 2 decimal places.').length).toBeGreaterThan(0);
    await user.clear(screen.getByLabelText(/^Price/));
    await user.type(screen.getByLabelText(/^Price/), 'abc');
    expect(screen.getAllByText('Enter a price like 24.50.').length).toBeGreaterThan(0);
    await user.clear(screen.getByLabelText(/^Price/));
    await user.type(screen.getByLabelText(/^Price/), '-1');
    expect(screen.getAllByText("A price can't be negative.").length).toBeGreaterThan(0);
    await user.clear(screen.getByLabelText('Stock'));
    await user.type(screen.getByLabelText('Stock'), '1.5');
    expect(screen.getAllByText('Enter a whole number, 0 or more.').length).toBeGreaterThan(0);
  });

  it('W04 AS-35: the price label carries the platform currency code and its fraction digits decide the input; no USD is assumed', async () => {
    const user = userEvent.setup();
    createForm(vi.fn(), 'JPY', 0);
    expect(screen.getByLabelText('Price (JPY)')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('USD');
    await user.type(screen.getByLabelText('Price (JPY)'), '12.5');
    await user.click(screen.getByRole('button', { name: 'Create product' }));
    expect(screen.getAllByText('Use a whole number.').length).toBeGreaterThan(0);
  });

  it('W04 AS-33: a valid form sends priceMinor from string parsing and the currency, shows "Creating…", and reports success', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    let body: unknown;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(products, async ({ request }) => {
        body = await request.json();
        await gate;
        return HttpResponse.json(productMemberFixture({ version: 1 }), { status: 201 });
      }),
    );
    createForm(onSaved);
    await fillRequired(user, '24,50');
    await user.clear(screen.getByLabelText('Stock'));
    await user.type(screen.getByLabelText('Stock'), '3');
    await user.click(screen.getByRole('button', { name: 'Create product' }));
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
    release();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(body).toEqual({ title: 'Handmade Ceramic Mug', brand: 'Clay Works', category: 'kitchen', priceMinor: 2450, currency: 'EUR', quantity: 3 });
    expect(toast.success).toHaveBeenCalledWith('Product created');
  });

  it('W04 AS-34: 400 validation_failed puts each message under its field, focuses the first, and keeps the values', async () => {
    const user = userEvent.setup();
    server.use(http.post(products, () => sellerProblem('validation_failed', { errors: [{ field: 'brand', code: 'too_long' }, { field: 'priceMinor', code: 'too_big' }] })));
    createForm();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(screen.getByLabelText('Brand')).toHaveFocus());
    expect(screen.getByLabelText('Brand')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^Price/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText('Check this field.').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText('Title')).toHaveValue('Handmade Ceramic Mug');
    expect(screen.getByLabelText(/^Price/)).toHaveValue('24.50');
    expect(document.body).not.toHaveTextContent('Server detail');
  });

  it('W04 AS-34: 422 currency_not_supported shows an alert in the form and keeps the values', async () => {
    const user = userEvent.setup();
    server.use(http.post(products, () => sellerProblem('currency_not_supported')));
    createForm();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create product' }));
    expect(await screen.findByText("That currency isn't supported for products yet.")).toBeInTheDocument();
    expect(screen.getByLabelText('Brand')).toHaveValue('Clay Works');
    expect(screen.getByRole('button', { name: 'Create product' })).toBeEnabled();
  });

  it('W04 AS-95: a summary alert lists the problems; each invalid field has aria-invalid and aria-describedby pointing at its message', async () => {
    const user = userEvent.setup();
    createForm();
    await user.click(screen.getByRole('button', { name: 'Create product' }));
    const summary = screen.getByRole('alert');
    expect(within(summary).getAllByRole('listitem').length).toBeGreaterThanOrEqual(4);
    for (const label of ['Title', 'Brand', 'Category', /^Price/]) {
      const field = screen.getByLabelText(label);
      expect(field).toHaveAttribute('aria-invalid', 'true');
      const message = document.getElementById(field.getAttribute('aria-describedby')?.split(' ').pop() ?? '');
      expect(message).toHaveTextContent(/^Enter /);
    }
    expect(screen.getByLabelText('Stock')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

describe('W04 product form (edit)', () => {
  const product = productMemberFixture({ version: 3, quantity: 12 });
  const editForm = (onSaved = vi.fn()) => wrap(<ProductForm mode="edit" shopId={SELLER_SHOP_ID} currency="EUR" fractionDigits={2} product={product} onSaved={onSaved} />);

  it('W04 AS-36: fields are prefilled and "Save changes" is disabled until something changes', async () => {
    const user = userEvent.setup();
    editForm();
    expect(screen.getByLabelText('Title')).toHaveValue('Handmade Ceramic Mug');
    expect(screen.getByLabelText(/^Price/)).toHaveValue('24.50');
    expect(screen.getByLabelText('Stock')).toHaveValue('12');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.type(screen.getByLabelText('Stock'), '3');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await user.clear(screen.getByLabelText('Stock'));
    await user.type(screen.getByLabelText('Stock'), '12');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('W04 AS-36: only the changed fields are sent, with the expectedVersion of the load', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    let body: unknown;
    server.use(
      http.patch(`${products}/${SELLER_PRODUCT_ID}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(productMemberFixture({ version: 4, quantity: 7, priceMinor: 3000 }));
      }),
    );
    editForm(onSaved);
    await user.clear(screen.getByLabelText('Stock'));
    await user.type(screen.getByLabelText('Stock'), '7');
    await user.clear(screen.getByLabelText(/^Price/));
    await user.type(screen.getByLabelText(/^Price/), '30');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(body).toEqual({ expectedVersion: 3, priceMinor: 3000, quantity: 7 });
    expect(toast.success).toHaveBeenCalledWith('Product updated');
  });

  it('W04 AS-37: a version conflict explains itself, offers "Load latest", and never overwrites; loading drops the unsaved edits and says so', async () => {
    const user = userEvent.setup();
    let patches = 0;
    server.use(
      http.patch(`${products}/${SELLER_PRODUCT_ID}`, () => {
        patches += 1;
        return sellerProblem('version_conflict');
      }),
      http.get(`${products}/${SELLER_PRODUCT_ID}`, () => HttpResponse.json(productMemberFixture({ version: 5, title: 'Mug, second batch', quantity: 2 }))),
    );
    editForm();
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'My edit');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This product changed since you opened it.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('My edit');
    await user.click(screen.getByRole('button', { name: 'Load latest' }));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Mug, second batch'));
    expect(screen.getByLabelText('Stock')).toHaveValue('2');
    expect(screen.getByRole('alert')).toHaveTextContent(/unsaved changes were dropped/i);
    expect(patches).toBe(1);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});
