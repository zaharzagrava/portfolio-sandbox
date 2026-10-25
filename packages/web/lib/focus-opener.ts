/**
 * The control a dialog should hand focus back to when it closes (W04 R-24). A menu item closes its menu before the dialog it
 * opens exists, so at that moment focus is on the page body and the dialog cannot learn the opener from `document.activeElement`.
 * The menu leaves its trigger here; a dialog that opens within a moment takes it.
 */
let remembered: { element: HTMLElement; at: number } | null = null;
const FRESH_MS = 1000;

export function rememberOpener(element: HTMLElement | null): void {
  remembered = element ? { element, at: Date.now() } : null;
}

/** The focused control, or (when focus is on the body) the opener a menu has just left. */
export function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  const found = remembered && Date.now() - remembered.at < FRESH_MS && remembered.element.isConnected ? remembered.element : null;
  remembered = null;
  return found;
}
