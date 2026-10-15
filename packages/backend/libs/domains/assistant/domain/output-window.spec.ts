import { OUTPUT_WINDOW_CHARS, OutputWindow } from './output-window';

describe('S46 AS-54: output moderation window', () => {
  it('S46 AS-54: the window is 256 characters', () => {
    expect(OUTPUT_WINDOW_CHARS).toBe(256);
  });

  it('S46 AS-54: the first chunk is checked alone', () => {
    expect(new OutputWindow().textToCheck('hello')).toBe('hello');
  });

  it('S46 AS-54: a later chunk is checked with the accepted text before it, so a split phrase is whole', () => {
    const w = new OutputWindow();
    w.accept('some text that ends with a forbi');
    expect(w.textToCheck('dden phrase')).toBe('some text that ends with a forbidden phrase');
  });

  it('S46 AS-54: only the last 256 accepted characters are kept', () => {
    const w = new OutputWindow();
    w.accept('a'.repeat(300));
    w.accept('b'.repeat(100));
    const text = w.textToCheck('c');
    expect(text).toBe('a'.repeat(156) + 'b'.repeat(100) + 'c');
  });

  it('S46 AS-54: a chunk that is not accepted (flagged) does not become context', () => {
    const w = new OutputWindow();
    w.accept('safe ');
    expect(w.textToCheck('FLAGGED')).toBe('safe FLAGGED');
    // not accepted
    expect(w.textToCheck('next')).toBe('safe next');
  });

  it('S46 AS-54: a chunk longer than the window is checked whole', () => {
    const w = new OutputWindow();
    w.accept('ctx');
    const chunk = 'z'.repeat(1000);
    expect(w.textToCheck(chunk)).toBe('ctx' + chunk);
  });

  it.each([
    [0, 0],
    [255, 255],
    [256, 256],
    [257, 256],
  ])('S46 AS-54: after %s accepted characters the context is %s long', (n, ctx) => {
    const w = new OutputWindow();
    w.accept('q'.repeat(n));
    expect(w.textToCheck('').length).toBe(ctx);
  });
});
