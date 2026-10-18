'use client';

import type { ComponentProps, Ref } from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import { MessageRow, type RowContext } from '@/components/chat/message-row';
import { Button } from '@/components/ui/button';
import type { Row } from '@/lib/chat/rows';

/** The list is virtualised: only rows near the viewport are in the page, so a chat of thousands stays responsive (AS-13, edge cases). */
export type ListContext = RowContext & {
  earlier: { state: 'more' | 'loading' | 'failed' | 'start'; onLoad: () => void };
};

function EarlierHeader({ context }: { context?: ListContext }) {
  if (!context) return null;
  const { state, onLoad } = context.earlier;
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
      {state === 'failed' && <p>Couldn&apos;t load earlier messages.</p>}
      {(state === 'more' || state === 'loading') && (
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" aria-disabled={state === 'loading' ? 'true' : undefined} onClick={() => state === 'more' && onLoad()}>
          Load earlier messages
        </Button>
      )}
      {state === 'failed' && (
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={onLoad}>
          Try again
        </Button>
      )}
      {state === 'start' && <p>Start of the chat</p>}
    </div>
  );
}

function List({ context, children, style, ref }: ComponentProps<'div'> & { context?: ListContext; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} style={style} role="list" aria-label={`Messages in ${context?.title ?? ''}`}>
      {children}
    </div>
  );
}

function Item({ children, style, ...rest }: ComponentProps<'div'> & { item?: unknown; context?: unknown }) {
  const { item: _item, context: _context, ...attributes } = rest;
  void _item;
  void _context;
  return (
    <div role="listitem" style={style} {...attributes}>
      {children}
    </div>
  );
}

const components: Components<Row, ListContext> = { Header: EarlierHeader, List, Item };

/** A position far from 0, so older pages can be added in front without the list jumping (Virtuoso `firstItemIndex`). */
export const FIRST_ITEM_BASE = 1_000_000;

export type MessageListHandle = { scrollToEnd: () => void };

export function MessageList({
  rows,
  context,
  firstItemIndex,
  initialIndex,
  onAtBottomChange,
  listRef,
}: {
  rows: Row[];
  context: ListContext;
  firstItemIndex: number;
  /** The row the view opens on: the unread separator, or the newest message. */
  initialIndex: number;
  onAtBottomChange?: (atBottom: boolean) => void;
  listRef?: Ref<VirtuosoHandle>;
}) {
  return (
    <div data-testid="message-list" data-first-item-index={firstItemIndex} data-initial-index={initialIndex} className="min-h-0 flex-1">
      <Virtuoso<Row, ListContext>
        ref={listRef}
        style={{ height: '100%' }}
        data={rows}
        context={context}
        components={components}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={initialIndex >= rows.length - 1 ? { index: 'LAST', align: 'end' } : { index: initialIndex, align: 'start' }}
        computeItemKey={(_, row) => row.key}
        itemContent={(_, row, ctx) => <MessageRow row={row} context={ctx} />}
        // Follow new rows only when the reader is already at the end; a reader who scrolled up is not moved (AS-23, AS-32).
        followOutput={(atBottom) => (atBottom ? 'auto' : false)}
        atBottomStateChange={onAtBottomChange}
        atBottomThreshold={160}
        increaseViewportBy={200}
      />
    </div>
  );
}
