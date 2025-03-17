import { DataBaristaLogger } from "./loggingUtils";

/**
 * Generic cache entry with TTL
 */
interface CacheEntry<T> {
  value: T;
  expiry: number;
}

/**
 * A simple in-memory cache utility with TTL support
 * Used to reduce database operations for frequently accessed data
 */
export class DataBaristaCache {
  private static instance: DataBaristaCache;
  private cache: Map<string, CacheEntry<any>> = new Map();
  
  // Default TTL in milliseconds (5 minutes)
  private defaultTTL: number = 5 * 60 * 1000;
  
  private constructor() {}
  
  /**
   * Get the singleton instance of the cache
   */
  public static getInstance(): DataBaristaCache {
    if (!DataBaristaCache.instance) {
      DataBaristaCache.instance = new DataBaristaCache();
    }
    return DataBaristaCache.instance;
  }
  
  /**
   * Set a value in the cache with an optional TTL
   * @param key Cache key
   * @param value Value to cache
   * @param ttl Time-to-live in milliseconds (optional, defaults to 5 minutes)
   */
  public set<T>(key: string, value: T, ttl?: number): void {
    const expiry = Date.now() + (ttl || this.defaultTTL);
    this.cache.set(key, { value, expiry });
    DataBaristaLogger.debug(`Cache: Set value for key "${key}" with expiry in ${(ttl || this.defaultTTL) / 1000}s`);
  }
  
  /**
   * Get a value from the cache
   * @param key Cache key
   * @returns The cached value or undefined if not found or expired
   */
  public get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      DataBaristaLogger.debug(`Cache: Miss for key "${key}"`);
      return undefined;
    }
    
    if (entry.expiry < Date.now()) {
      // Entry has expired
      DataBaristaLogger.debug(`Cache: Expired entry for key "${key}"`);
      this.cache.delete(key);
      return undefined;
    }
    
    DataBaristaLogger.debug(`Cache: Hit for key "${key}"`);
    return entry.value as T;
  }
  
  /**
   * Check if a key exists in the cache and is not expired
   * @param key Cache key
   * @returns True if the key exists and is not expired
   */
  public has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.expiry < Date.now()) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }
  
  /**
   * Delete a key from the cache
   * @param key Cache key
   */
  public delete(key: string): void {
    this.cache.delete(key);
    DataBaristaLogger.debug(`Cache: Deleted key "${key}"`);
  }
  
  /**
   * Clear all cached values
   */
  public clear(): void {
    this.cache.clear();
    DataBaristaLogger.debug(`Cache: Cleared all entries`);
  }
  
  /**
   * Remove all expired entries from the cache
   * @returns Number of entries removed
   */
  public cleanup(): number {
    const now = Date.now();
    let count = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiry < now) {
        this.cache.delete(key);
        count++;
      }
    }
    
    if (count > 0) {
      DataBaristaLogger.debug(`Cache: Cleaned up ${count} expired entries`);
    }
    
    return count;
  }
  
  /**
   * Get a value from the cache if it exists, otherwise compute and cache it
   * @param key Cache key
   * @param computeFn Function to compute the value if not in cache
   * @param ttl Time-to-live in milliseconds (optional)
   * @returns The cached or computed value
   */
  public async getOrCompute<T>(
    key: string, 
    computeFn: () => Promise<T>, 
    ttl?: number
  ): Promise<T> {
    const cachedValue = this.get<T>(key);
    
    if (cachedValue !== undefined) {
      return cachedValue;
    }
    
    const computedValue = await computeFn();
    this.set(key, computedValue, ttl);
    return computedValue;
  }
}

// Export the singleton instance
export const dataCache = DataBaristaCache.getInstance(); 