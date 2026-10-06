/**
 * Reservoir sampling (Algorithm R): a uniform random sample of k items from a
 * stream of unknown length in O(k) memory, one pass. Each 250 ms tick of a
 * 5k/s comment firehose (~1,250 comments) becomes k = 5 fair picks - every
 * comment had the same chance, early or late in the window.
 */
export class Reservoir<T> {
  private items: T[] = [];
  private seen = 0;

  constructor(
    private readonly k: number,
    private readonly random: () => number = Math.random,
  ) {}

  offer(item: T): void {
    this.seen++;
    if (this.items.length < this.k) {
      this.items.push(item);
      return;
    }
    const j = Math.floor(this.random() * this.seen);
    if (j < this.k) this.items[j] = item;
  }

  /** Returns the sample and the count it was drawn from, and resets for the next window. */
  drain(): { sample: T[]; seen: number } {
    const result = { sample: this.items, seen: this.seen };
    this.items = [];
    this.seen = 0;
    return result;
  }
}
