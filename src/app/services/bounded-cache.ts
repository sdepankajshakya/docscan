/**
 * Bounded Memory Cache with Least-Recently-Used (LRU) eviction.
 * Keeps memory usage bounded by evicting older entries when maxEntries is reached.
 */
export class BoundedMemoryCache<K, V> {
    private cache = new Map<K, V>();
    private maxEntries: number;
    private readonly onEvict?: (key: K, value: V) => void;

    constructor(options?: { maxEntries?: number; onEvict?: (key: K, value: V) => void }) {
        this.maxEntries = options?.maxEntries ?? 5;
        this.onEvict = options?.onEvict;
    }

    public setMaxEntries(count: number): void {
        this.maxEntries = Math.max(1, count);
        while (this.cache.size > this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                const oldestValue = this.cache.get(oldestKey)!;
                this.cache.delete(oldestKey);
                if (this.onEvict) {
                    try {
                        this.onEvict(oldestKey, oldestValue);
                    } catch (e) {
                        console.warn('Error in BoundedMemoryCache onEvict:', e);
                    }
                }
            }
        }
    }

    public get(key: K): V | undefined {
        if (!this.cache.has(key)) {
            return undefined;
        }
        // Refresh LRU order (delete and re-insert)
        const value = this.cache.get(key)!;
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    public set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxEntries) {
            // Evict oldest entry (first item in Map iteration order)
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                const oldestValue = this.cache.get(oldestKey)!;
                this.cache.delete(oldestKey);
                if (this.onEvict) {
                    try {
                        this.onEvict(oldestKey, oldestValue);
                    } catch (e) {
                        console.warn('Error in BoundedMemoryCache onEvict:', e);
                    }
                }
            }
        }
        this.cache.set(key, value);
    }

    public has(key: K): boolean {
        return this.cache.has(key);
    }

    public delete(key: K): boolean {
        if (this.cache.has(key)) {
            const val = this.cache.get(key)!;
            const deleted = this.cache.delete(key);
            if (this.onEvict) {
                try {
                    this.onEvict(key, val);
                } catch (e) {
                    console.warn('Error in BoundedMemoryCache onEvict:', e);
                }
            }
            return deleted;
        }
        return false;
    }

    public clear(): void {
        if (this.onEvict) {
            for (const [k, v] of this.cache.entries()) {
                try {
                    this.onEvict(k, v);
                } catch (e) {
                    console.warn('Error in BoundedMemoryCache onEvict during clear:', e);
                }
            }
        }
        this.cache.clear();
    }

    public get size(): number {
        return this.cache.size;
    }
}

