import { LRUCache } from 'lru-cache';

/**
 * Thin LRU wrapper with a per-entry TTL.
 * Used to cache candles/orderbook responses so we don't burn Bitget's
 * 10 req/sec quota on repeated calls.
 */
export class TTLCache<V> {
  private readonly cache: LRUCache<string, V>;

  constructor(
    private readonly ttlMs: number,
    private readonly maxItems: number = 500,
  ) {
    // Cast: lru-cache requires V extends {}, but the underlying map is
    // erased at runtime, so this is purely a TypeScript plumbing shim.
    this.cache = new LRUCache<string, V>({
      max: maxItems,
      ttl: ttlMs,
      ttlAutopurge: true,
    }) as unknown as LRUCache<string, V>;
  }

  get(key: string): V | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: V): void {
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}