'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Star } from 'lucide-react';
import type { SearchFacets } from '@marketplace-sandbox/contracts';
import { cn } from '@/lib/utils';
import { facetLabel } from '@/lib/search/facet-label';
import { bandFields, bandLabel, minorToField, parsePriceInput, type PriceBandKey, type PriceInputResult } from '@/lib/search/price-input';
import type { SearchView } from '@/lib/search/search-view';

export type FilterPatch = Partial<SearchView>;

const FACET_LIMIT = 20;
const RATINGS = [4, 3, 2, 1] as const;

const choice = (selected: boolean) =>
  cn(
    'flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 max-sm:min-h-11',
    selected && 'bg-accent font-medium',
  );

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="mb-2 text-sm font-semibold">{title}</legend>
      <div className="space-y-1">{children}</div>
    </fieldset>
  );
}

/** A facet list (category or brand): the API's order and counts, single choice, the selected value clears itself. */
function FacetGroup({ title, field, buckets, view, onChange }: { title: string; field: 'category' | 'brand'; buckets: { key: string; count: number }[]; view: SearchView; onChange: (patch: FilterPatch) => void }) {
  if (buckets.length === 0) return null;
  return (
    <Group title={title}>
      {buckets.slice(0, FACET_LIMIT).map(({ key, count }) => {
        const selected = view[field] === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={selected}
            aria-label={`${facetLabel(key)} (${count})`}
            className={choice(selected)}
            onClick={() => onChange({ [field]: selected ? undefined : key })}
          >
            <span>{facetLabel(key)}</span>
            <span className="text-xs text-muted-foreground">{count}</span>
          </button>
        );
      })}
    </Group>
  );
}

/** The price fields (major units) and the four bands; they are remounted when the address' bounds change. */
function PriceGroup({ view, bands, currency, onChange }: { view: SearchView; bands: SearchFacets['priceRanges']; currency: string; onChange: (patch: FilterPatch) => void }) {
  const [min, setMin] = useState(minorToField(view.minPriceMinor, currency));
  const [max, setMax] = useState(minorToField(view.maxPriceMinor, currency));
  const [errors, setErrors] = useState<Extract<PriceInputResult, { ok: false }>['errors']>({});
  const id = useId();

  // The fields follow the address when its bounds change (chip removal, back/forward). Adjusting state while rendering
  // keeps the focused control mounted, which a `key` remount would not.
  const bounds = `${view.minPriceMinor ?? ''}:${view.maxPriceMinor ?? ''}:${currency}`;
  const [seenBounds, setSeenBounds] = useState(bounds);
  if (seenBounds !== bounds) {
    setSeenBounds(bounds);
    setMin(minorToField(view.minPriceMinor, currency));
    setMax(minorToField(view.maxPriceMinor, currency));
    setErrors({});
  }

  const apply = (minText: string, maxText: string) => {
    const result = parsePriceInput(minText, maxText, currency);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onChange({ minPriceMinor: result.minPriceMinor, maxPriceMinor: result.maxPriceMinor });
  };

  const message = errors.range ?? undefined;
  return (
    <Group title="Price">
      {bands.map(({ key, count }) => (
        <button
          key={key}
          type="button"
          aria-label={`${bandLabel(key as PriceBandKey, currency)} (${count})`}
          className={choice(false)}
          onClick={() => {
            const fields = bandFields(key as PriceBandKey);
            setMin(fields.min);
            setMax(fields.max);
            apply(fields.min, fields.max);
          }}
        >
          <span>{bandLabel(key as PriceBandKey, currency)}</span>
          <span className="text-xs text-muted-foreground">{count}</span>
        </button>
      ))}
      <div className="flex items-end gap-2 pt-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-min`} className="mb-1 block text-xs text-muted-foreground">
            Minimum price
          </label>
          <input
            id={`${id}-min`}
            inputMode="decimal"
            autoComplete="off"
            value={min}
            onChange={(event) => setMin(event.target.value)}
            aria-invalid={errors.min || errors.range ? true : undefined}
            aria-describedby={errors.min ? `${id}-min-error` : message ? `${id}-range-error` : undefined}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50 max-sm:h-11"
          />
        </div>
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-max`} className="mb-1 block text-xs text-muted-foreground">
            Maximum price
          </label>
          <input
            id={`${id}-max`}
            inputMode="decimal"
            autoComplete="off"
            value={max}
            onChange={(event) => setMax(event.target.value)}
            aria-invalid={errors.max || errors.range ? true : undefined}
            aria-describedby={errors.max ? `${id}-max-error` : message ? `${id}-range-error` : undefined}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50 max-sm:h-11"
          />
        </div>
        <button
          type="submit"
          onClick={() => apply(min, max)}
          className="h-9 rounded-md border px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 max-sm:h-11"
        >
          Apply
        </button>
      </div>
      {errors.min ? (
        <p id={`${id}-min-error`} className="text-xs text-destructive">
          {errors.min}
        </p>
      ) : null}
      {errors.max ? (
        <p id={`${id}-max-error`} className="text-xs text-destructive">
          {errors.max}
        </p>
      ) : null}
      {message ? (
        <p id={`${id}-range-error`} className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
    </Group>
  );
}

/**
 * The filter panel (W02 FR-027..FR-030): a labelled form. It renders the facets exactly as the API gave them, invents no
 * value and no count, and reports a change as a patch of the view; it keeps no filter state of its own except the price
 * text being typed. `disabled` is pickup mode: values stay, controls do not work (AS-30).
 */
export function FilterPanel({
  view,
  facets,
  currency,
  onChange,
  disabled = false,
}: {
  view: SearchView;
  facets?: SearchFacets;
  currency: string;
  onChange: (patch: FilterPatch) => void;
  onClearAll?: () => void;
  disabled?: boolean;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };
  return (
    <form aria-label="Filters" onSubmit={submit} noValidate className="space-y-5" data-testid="filter-panel">
      <fieldset disabled={disabled} className="min-w-0 space-y-5 border-0 p-0">
        {disabled ? <p className="text-sm text-muted-foreground">Not available together with pickup search.</p> : null}

        {view.semantic ? (
          <p className="text-sm text-muted-foreground">Counts aren&apos;t available for meaning search.</p>
        ) : (
          <>
            <FacetGroup title="Category" field="category" buckets={facets?.categories ?? []} view={view} onChange={onChange} />
            <FacetGroup title="Brand" field="brand" buckets={facets?.brands ?? []} view={view} onChange={onChange} />
          </>
        )}

        <PriceGroup view={view} bands={facets?.priceRanges ?? []} currency={currency} onChange={onChange} />

        <Group title="Rating">
          {facets?.avgRating != null && !view.semantic ? (
            <p className="flex items-center gap-1 px-2 text-sm text-muted-foreground">
              <Star aria-hidden="true" className="size-3.5 fill-primary text-primary" />
              {`Average rating ${facets.avgRating.toFixed(1)}`}
            </p>
          ) : null}
          {RATINGS.map((stars) => {
            const selected = view.minRating === stars;
            return (
              <button
                key={stars}
                type="button"
                aria-pressed={selected}
                className={choice(selected)}
                onClick={() => onChange({ minRating: selected ? undefined : stars })}
              >
                {`${stars} ${stars === 1 ? 'star' : 'stars'} & up`}
              </button>
            );
          })}
        </Group>

        <button
          type="button"
          role="switch"
          aria-checked={view.inStock === true}
          onClick={() => onChange({ inStock: view.inStock ? undefined : true })}
          className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 max-sm:min-h-11"
        >
          <span>In stock only</span>
          <span aria-hidden="true" className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', view.inStock ? 'bg-primary' : 'bg-input')}>
            <span className={cn('size-4 rounded-full bg-background transition-transform motion-reduce:transition-none', view.inStock && 'translate-x-4')} />
          </span>
        </button>
      </fieldset>
    </form>
  );
}
