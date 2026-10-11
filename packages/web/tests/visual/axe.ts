import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** W02 (AS-75): axe findings of impact serious or critical, as readable lines; empty when the page is clean. */
export async function seriousViolations(page: Page, selector?: string): Promise<string[]> {
  const builder = new AxeBuilder({ page });
  const { violations } = await (selector ? builder.include(selector) : builder).analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
}

/** Asserts serious/critical = 0 for the whole page, or for one region. */
export async function expectNoSeriousViolations(page: Page, selector?: string): Promise<void> {
  expect(await seriousViolations(page, selector)).toEqual([]);
}

/**
 * The page content (`#main-content`, not the site header that W07 owns) fits the viewport width: no element sticks out
 * unless it sits inside a container that scrolls on purpose (the tab list, the chip row). Call at 320 px.
 */
export async function expectMainFitsWidth(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const main = document.querySelector('#main-content');
    if (!main) return ['#main-content missing'];
    const width = document.documentElement.clientWidth;
    const scrolls = (el: Element) => {
      for (let node = el.parentElement; node && node !== main.parentElement; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX;
        if (node !== el && (overflowX === 'auto' || overflowX === 'scroll') && node.getBoundingClientRect().right <= width + 0.5) return true;
      }
      return false;
    };
    return [...main.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > width + 0.5 && !scrolls(el))
      .map((el) => `${el.tagName}.${String((el as HTMLElement).className).slice(0, 50)} right=${Math.round(el.getBoundingClientRect().right)}`);
  });
  expect(offenders).toEqual([]);
}

/** Layout rule shared by every visual state: nothing scrolls sideways (checked at 320 px by the callers). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}
