import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BreachCheckerPort } from '../../domain/ports';

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 800;

/**
 * Breached-password lookup by k-anonymity range query (FR-005, FR-006): only the first five hex characters of the
 * SHA-1 leave the process, the suffix is compared locally. A timeout or any failure rejects; the caller fails open
 * and counts the skip.
 */
@Injectable()
export class RangeBreachChecker implements BreachCheckerPort {
  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1')
      .update(password)
      .digest('hex')
      .toUpperCase();
    const response = await fetch(`${RANGE_URL}${sha1.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`breach range lookup ${response.status}`);
    const suffix = sha1.slice(5);
    return (await response.text()).split('\n').some((line) => {
      const [candidate, count] = line.trim().split(':');
      return candidate === suffix && Number(count) > 0;
    });
  }
}
