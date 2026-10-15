export const OUTPUT_WINDOW_CHARS = 256;

/**
 * Context for streamed-output moderation (S46 AS-54): each chunk is checked together with the last 256 characters
 * that were already published, so a phrase split across two chunks is seen whole. A flagged chunk is never accepted,
 * so it never becomes context.
 */
export class OutputWindow {
  private tail = '';

  /** The 256 characters published before the next chunk. */
  context(): string {
    return this.tail;
  }

  textToCheck(chunk: string): string {
    return this.tail + chunk;
  }

  accept(chunk: string): void {
    this.tail = (this.tail + chunk).slice(-OUTPUT_WINDOW_CHARS);
  }
}
