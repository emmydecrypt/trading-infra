import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TTLCache } from '../src/cache.js';
import { RateLimiter } from '../src/rate-limit.js';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves a value within TTL', () => {
    const cache = new TTLCache<string>(60_000);
    cache.set('foo', 'bar');
    expect(cache.get('foo')).toBe('bar');
    expect(cache.has('foo')).toBe(true);
  });

  it('expires a value after the TTL', async () => {
    const cache = new TTLCache<string>(50);
    cache.set('foo', 'bar');
    expect(cache.get('foo')).toBe('bar');
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.get('foo')).toBeUndefined();
    expect(cache.has('foo')).toBe(false);
  });

  it('evicts LRU when max items is exceeded', () => {
    const cache = new TTLCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('clear empties the cache', () => {
    const cache = new TTLCache<number>(60_000);
    cache.set('a', 1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('does not exceed maxPerSecond over many calls', async () => {
    const limiter = new RateLimiter(20);
    let count = 0;
    const start = Date.now();
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      promises.push(limiter.acquire().then(() => { count += 1; }));
    }
    await Promise.all(promises);
    const elapsed = Date.now() - start;
    // 25 tokens at 20/s → expect ~250ms total elapsed (bucket refills as it drains).
    expect(count).toBe(25);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });
});