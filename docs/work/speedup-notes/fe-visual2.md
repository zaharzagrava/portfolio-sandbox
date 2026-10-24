# Front-end visual tests, second round: three flaky tests

## Notifications panel "dialog not found" (tests/visual/notifications.spec.ts)
- Cause: the test pressed the bell as soon as it showed. If the page was still loading its scripts (busy machine), the press did nothing, so the panel never opened.
- Fix: before pressing, wait until the page has attached its code to the bell. Every check is unchanged.
- Alone it never failed in 24 runs; the old failure only shows when the machine is busy.

## Product page "all optional sections missing" (tests/visual/product-page.spec.ts)
- Not a real low-contrast bug. The grey text (#858585) is the Share button while it is switched off (half faded) and fading in once the page knows who is signed in. The accessibility scan caught it mid-fade.
- Fix: the test waits until Share is enabled before scanning (another test in this file already does the same). No colour changes: the finished button has normal contrast.

## Chat "connection banner and the jump pill" (tests/visual/chat.visual.spec.ts)
- Cause: the page learns "the reader scrolled up" a moment after the scroll. The test delivered the new message too soon, so the page counted it as already read and showed no pill. Failed on phone size every time with a retry loop only; a fixed 1.5 s pause made it pass, which proved the cause.
- Fix: after scrolling up, the test waits until the list has held still for 30 screen frames (no sleeping), then sends the new message. The "back online" signal is also repeated until the pill shows, in case a sync was already in flight.
- Nothing weakened; no picture was regenerated.
