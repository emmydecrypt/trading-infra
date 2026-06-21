/**
 * Token-bucket-ish rate limiter enforcing max N requests per second.
 * Simple, dependency-free. Sufficient for keeping us below Bitget's
 * 10 req/sec public-endpoint ceiling.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;

  constructor(maxPerSecond: number) {
    if (maxPerSecond <= 0) {
      throw new Error('maxPerSecond must be > 0');
    }
    this.capacity = maxPerSecond;
    this.refillPerMs = maxPerSecond / 1000;
    this.tokens = maxPerSecond;
    this.lastRefill = Date.now();
  }

  /**
   * Wait until a token is available, then consume it.
   */
  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil(deficit / this.refillPerMs);
      await sleep(Math.max(waitMs, 1));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}