import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';

/** Writes load-test-<flow>.html/.json next to where k6 was launched. */
export function summaryFor(flow) {
  return (data) => ({
    [`load-test-${flow}.html`]: htmlReport(data),
    [`load-test-${flow}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  });
}
