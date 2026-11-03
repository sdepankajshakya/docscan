import { BoundedMemoryCache } from './bounded-cache';

describe('BoundedMemoryCache', () => {
    it('should store and retrieve items', () => {
        const cache = new BoundedMemoryCache<string, number>({ maxEntries: 3 });
        cache.set('a', 1);
        cache.set('b', 2);

        expect(cache.get('a')).toBe(1);
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBeUndefined();
    });

    it('should evict least recently used item when maxEntries is exceeded', () => {
        const evicted: Array<{ k: string; v: number }> = [];
        const cache = new BoundedMemoryCache<string, number>({
            maxEntries: 3,
            onEvict: (k, v) => evicted.push({ k, v })
        });

        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        // Access 'a' so 'b' becomes least recently used
        cache.get('a');

        // Insert 'd' -> should evict 'b'
        cache.set('d', 4);

        expect(cache.size).toBe(3);
        expect(cache.has('b')).toBeFalse();
        expect(cache.has('a')).toBeTrue();
        expect(cache.has('c')).toBeTrue();
        expect(cache.has('d')).toBeTrue();

        expect(evicted.length).toBe(1);
        expect(evicted[0]).toEqual({ k: 'b', v: 2 });
    });

    it('should dynamically reduce capacity and evict older entries when setMaxEntries is called', () => {
        const evicted: string[] = [];
        const cache = new BoundedMemoryCache<string, number>({
            maxEntries: 5,
            onEvict: (k) => evicted.push(k)
        });

        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.set('d', 4);

        // Dynamically shrink capacity to 2 under memory pressure
        cache.setMaxEntries(2);

        expect(cache.size).toBe(2);
        expect(evicted).toEqual(['a', 'b']);
        expect(cache.has('c')).toBeTrue();
        expect(cache.has('d')).toBeTrue();
    });

    it('should clear all entries', () => {
        const evicted: string[] = [];
        const cache = new BoundedMemoryCache<string, string>({
            maxEntries: 5,
            onEvict: (k) => evicted.push(k)
        });

        cache.set('1', 'one');
        cache.set('2', 'two');
        cache.clear();

        expect(cache.size).toBe(0);
        expect(cache.get('1')).toBeUndefined();
        expect(evicted).toEqual(['1', '2']);
    });
});

