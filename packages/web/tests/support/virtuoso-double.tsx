import { useEffect, useImperativeHandle, type ComponentType, type ReactNode, type Ref } from 'react';

/**
 * A stand-in for `react-virtuoso` in jsdom (research R-10). The real list measures the viewport and positions rows by
 * scrolling, which jsdom cannot do, so it renders nothing there. This double renders every row of `data` through the same
 * `components` (Header, List, Item) and `itemContent`, in order, with the keys `computeItemKey` gives, and records what the
 * page asked of it so tests can assert the behaviour at the component boundary: the prepend offset (`firstItemIndex`), where
 * it opens (`initialTopMostItemIndex`), whether it follows new rows (`followOutput`) and imperative scrolls.
 */
type Handle = { scrollToIndex: (location: unknown) => void; scrollTo: (location: unknown) => void; scrollBy: (location: unknown) => void };

export const virtuosoCalls = {
  scrolls: [] as unknown[],
  last: null as null | { followOutput?: (atBottom: boolean) => 'auto' | 'smooth' | false; firstItemIndex?: number; initialTopMostItemIndex?: unknown; atBottomStateChange?: (atBottom: boolean) => void },
  reset() {
    this.scrolls = [];
    this.last = null;
  },
};

type Props = {
  data?: unknown[];
  context?: unknown;
  firstItemIndex?: number;
  initialTopMostItemIndex?: unknown;
  followOutput?: (atBottom: boolean) => 'auto' | 'smooth' | false;
  atBottomStateChange?: (atBottom: boolean) => void;
  computeItemKey?: (index: number, item: never, context: never) => React.Key;
  itemContent?: (index: number, item: never, context: never) => ReactNode;
  components?: {
    Header?: ComponentType<{ context?: unknown }>;
    Footer?: ComponentType<{ context?: unknown }>;
    List?: ComponentType<{ context?: unknown; children?: ReactNode }>;
    Item?: ComponentType<Record<string, unknown> & { children?: ReactNode }>;
  };
  ref?: Ref<Handle>;
};

export function Virtuoso({ data = [], context, firstItemIndex = 0, initialTopMostItemIndex, followOutput, atBottomStateChange, computeItemKey, itemContent, components = {}, ref }: Props) {
  useEffect(() => {
    virtuosoCalls.last = { followOutput, firstItemIndex, initialTopMostItemIndex, atBottomStateChange };
  });
  useImperativeHandle(ref, () => ({
    scrollToIndex: (location) => virtuosoCalls.scrolls.push(location),
    scrollTo: (location) => virtuosoCalls.scrolls.push(location),
    scrollBy: (location) => virtuosoCalls.scrolls.push(location),
  }));
  const { Header, Footer, List, Item } = components;
  const rows = data.map((row, index) => {
    const absolute = firstItemIndex + index;
    const content = itemContent?.(absolute, row as never, context as never);
    const key = computeItemKey ? computeItemKey(absolute, row as never, context as never) : absolute;
    return Item ? (
      <Item key={key} data-index={index} data-item-index={absolute} item={row} context={context}>
        {content}
      </Item>
    ) : (
      <div key={key}>{content}</div>
    );
  });
  return (
    <div data-testid="virtuoso-double">
      {Header && <Header context={context} />}
      {List ? <List context={context}>{rows}</List> : <div>{rows}</div>}
      {Footer && <Footer context={context} />}
    </div>
  );
}

export const VirtuosoMockContext = { Provider: ({ children }: { children?: ReactNode }) => <>{children}</> };
