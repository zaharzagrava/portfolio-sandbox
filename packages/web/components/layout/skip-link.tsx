/** First focusable element of every page; visible only while focused. The target is `main#main-content` (focusable, tabIndex -1). */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground focus:shadow-lg"
    >
      Skip to main content
    </a>
  );
}
