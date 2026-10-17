'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ShopListItem } from '@/lib/api/seller';
import { roleLabel, SELLER_HOME, switchShopHref } from '@/lib/seller/nav';

/** The switcher lists this many shops and links to the picker for more (W04 edge cases, AS-09). */
export const SWITCHER_SHOW = 50;

const STATUS_LABEL: Record<string, string> = { SUSPENDED: 'Suspended', DELETING: 'Closing', DELETED: 'Closed' };

/**
 * The shop switcher of the sidebar and drawer (W04 FR-011, AS-09): the first 50 shops of `GET /shops/mine`, each with its
 * name, handle, the member's role and a badge when the shop is not active. Choosing one keeps the section the member is
 * in. Presentation only: the shop list comes from the server render.
 */
export function ShopSwitcher({
  shops,
  currentShopId,
  nextCursor,
  onNavigate,
}: {
  shops: readonly ShopListItem[];
  currentShopId: string;
  nextCursor?: string | null;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);

  // The address changed while open (a link, or Back): close.
  if (open && openedAt !== pathname) setOpen(false);

  const current = shops.find((shop) => shop.id === currentShopId);
  const shown = shops.slice(0, SWITCHER_SHOW);
  const moreHref = nextCursor ? `${SELLER_HOME}?cursor=${encodeURIComponent(nextCursor)}` : SELLER_HOME;

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          if (!open) setOpenedAt(pathname);
          setOpen(!open);
        }}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-left text-sm font-medium hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-9"
      >
        <span className="truncate">{current?.name ?? 'Switch shop'}</span>
        <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="mt-2 rounded-lg border bg-background p-1 shadow-sm">
          <ul id={listId} aria-label="Your shops" className="max-h-72 overflow-y-auto">
            {shown.map((shop) => {
              const isCurrent = shop.id === currentShopId;
              return (
                <li key={shop.id}>
                  <Link
                    href={switchShopHref(pathname, currentShopId, shop.id)}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => {
                      setOpen(false);
                      onNavigate?.();
                    }}
                    className="flex min-h-11 items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{shop.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{shop.slug}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        <Badge variant="secondary">{roleLabel(shop.role)}</Badge>
                        {shop.status !== 'ACTIVE' && <Badge variant="outline">{STATUS_LABEL[shop.status] ?? shop.status}</Badge>}
                      </span>
                    </span>
                    {isCurrent && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <CheckIcon aria-hidden="true" className="size-3" />
                        Current
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          <Link
            href={moreHref}
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
            className="mt-1 flex min-h-11 items-center rounded-md px-2 text-sm text-primary underline-offset-4 hover:underline sm:min-h-8"
          >
            All your shops
          </Link>
        </div>
      )}
    </div>
  );
}
