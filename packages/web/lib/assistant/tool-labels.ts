import type { ToolStatus } from './reply-reducer';

/**
 * The text of a tool-use chip (W05 AS-43). The text is part of the chip, never only an icon. Tools the page does not know show
 * their name with the underscores replaced by spaces.
 */
const KNOWN: Record<string, Record<ToolStatus, string>> = {
  search_products: { running: 'Searching products…', done: 'Searched products', failed: "Couldn't search products" },
  product_details: { running: 'Reading product details…', done: 'Read product details', failed: "Couldn't read product details" },
  pickup_near_me: { running: 'Checking pickup points near you…', done: 'Checked pickup points', failed: "Couldn't check pickup points" },
};

export function toolLabel(name: string, status: ToolStatus): string {
  const known = Object.hasOwn(KNOWN, name) ? KNOWN[name] : undefined;
  if (known) return known[status];
  return name.split('_').filter(Boolean).join(' ') || 'tool';
}

/** The status in words, for a screen reader next to the spinner, check or cross. */
export function toolStatusText(status: ToolStatus): string {
  return status === 'running' ? 'In progress' : status === 'done' ? 'Done' : 'Failed';
}
