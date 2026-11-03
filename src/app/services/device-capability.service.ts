import { Injectable } from '@angular/core';

export type DeviceTier = 'low' | 'mid' | 'high';

export interface DeviceMemoryInfo {
    deviceMemoryGB?: number;
    hardwareConcurrency: number;
    usedJSHeapMB?: number;
    totalJSHeapMB?: number;
    heapLimitMB?: number;
    heapUsageRatio?: number;
}

export interface AdaptiveConfig {
    tier: DeviceTier;
    maxCacheEntries: number;
    previewResolution: number;
    thumbnailResolution: number;
    thumbnailQuality: number;
    thumbnailBatchSize: number;
    thumbnailYieldMs: number;
    exportScale: number;
    exportQuality: number; // Strictly preserved (never reduced below high-res per req 8)
    isUnderMemoryPressure: boolean;
    isUnderStoragePressure: boolean;
}

@Injectable({
    providedIn: 'root'
})
export class DeviceCapabilityService {

    private _tier: DeviceTier = 'mid';
    private _lastStorageCheck = 0;
    private _isStorageCritical = false;

    constructor() {
        this._tier = this.detectTier();
    }

    /**
     * Detects hardware tier based on deviceMemory, CPU concurrency, and heap limits.
     */
    public detectTier(): DeviceTier {
        const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
        const deviceMemory = nav?.deviceMemory;
        const cores = nav?.hardwareConcurrency || 4;

        // Check if performance.memory is available
        const memory = this.getMemoryInfo();
        const heapLimitMB = memory.heapLimitMB || 512;

        if ((deviceMemory !== undefined && deviceMemory <= 2) || cores <= 2 || heapLimitMB < 384) {
            return 'low';
        }

        if ((deviceMemory !== undefined && deviceMemory >= 6) && cores >= 8 && heapLimitMB >= 1024) {
            return 'high';
        }

        return 'mid';
    }

    /**
     * Get real-time heap memory usage if platform APIs allow.
     */
    public getMemoryInfo(): DeviceMemoryInfo {
        const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
        const perf = typeof performance !== 'undefined' ? (performance as any) : null;
        const memory = perf?.memory;

        let usedJSHeapMB: number | undefined;
        let totalJSHeapMB: number | undefined;
        let heapLimitMB: number | undefined;
        let heapUsageRatio: number | undefined;

        if (memory) {
            usedJSHeapMB = Math.round(memory.usedJSHeapSize / (1024 * 1024));
            totalJSHeapMB = Math.round(memory.totalJSHeapSize / (1024 * 1024));
            heapLimitMB = Math.round(memory.jsHeapSizeLimit / (1024 * 1024));
            if (heapLimitMB > 0) {
                heapUsageRatio = memory.usedJSHeapSize / memory.jsHeapSizeLimit;
            }
        }

        return {
            deviceMemoryGB: nav?.deviceMemory,
            hardwareConcurrency: nav?.hardwareConcurrency || 4,
            usedJSHeapMB,
            totalJSHeapMB,
            heapLimitMB,
            heapUsageRatio
        };
    }

    /**
     * Checks if the device is currently experiencing critical memory pressure (>75% heap usage).
     */
    public isMemoryPressureCritical(): boolean {
        const info = this.getMemoryInfo();
        if (info.heapUsageRatio !== undefined) {
            return info.heapUsageRatio > 0.75;
        }
        return false;
    }

    /**
     * Estimate remaining storage if StorageManager API is supported.
     */
    public async checkStoragePressure(): Promise<boolean> {
        // Cache result for 30 seconds to avoid spamming async storage calls
        const now = Date.now();
        if (now - this._lastStorageCheck < 30000) {
            return this._isStorageCritical;
        }
        this._lastStorageCheck = now;

        try {
            if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
                const estimate = await navigator.storage.estimate();
                if (estimate.quota !== undefined && estimate.usage !== undefined) {
                    const availableBytes = estimate.quota - estimate.usage;
                    const availableMB = availableBytes / (1024 * 1024);
                    // Less than 50MB free is critical
                    this._isStorageCritical = availableMB < 50;
                    return this._isStorageCritical;
                }
            }
        } catch (e) {
            // Storage estimate not supported or denied
        }
        this._isStorageCritical = false;
        return false;
    }

    /**
     * Returns adaptive resource limits tuned for the current device tier and memory condition.
     */
    public getAdaptiveConfig(): AdaptiveConfig {
        const isMemCritical = this.isMemoryPressureCritical();
        const tier = isMemCritical ? 'low' : this._tier;

        if (tier === 'low') {
            return {
                tier: 'low',
                maxCacheEntries: 2,           // Very tight bounded memory cache
                previewResolution: 1000,      // Lightweight preview for responsiveness
                thumbnailResolution: 140,     // Compact thumbnails for low-end devices
                thumbnailQuality: 0.55,
                thumbnailBatchSize: 1,        // Process 1 thumbnail at a time
                thumbnailYieldMs: 16,         // Yield 16ms (1 full frame) between thumbnails
                exportScale: 2.0,             // Sharp 2.0x export (preserves high print quality)
                exportQuality: 0.95,          // Never compromise final export quality (req 8)
                isUnderMemoryPressure: isMemCritical,
                isUnderStoragePressure: this._isStorageCritical
            };
        } else if (tier === 'high') {
            return {
                tier: 'high',
                maxCacheEntries: 8,           // Larger bounded cache on high-end devices
                previewResolution: 1800,      // Rich crisp preview on powerful devices
                thumbnailResolution: 200,
                thumbnailQuality: 0.70,
                thumbnailBatchSize: 4,        // Faster batch processing
                thumbnailYieldMs: 0,
                exportScale: 2.5,
                exportQuality: 0.95,
                isUnderMemoryPressure: isMemCritical,
                isUnderStoragePressure: this._isStorageCritical
            };
        } else {
            // Mid-range tier
            return {
                tier: 'mid',
                maxCacheEntries: 4,
                previewResolution: 1400,
                thumbnailResolution: 170,
                thumbnailQuality: 0.65,
                thumbnailBatchSize: 2,
                thumbnailYieldMs: 4,
                exportScale: 2.2,
                exportQuality: 0.95,
                isUnderMemoryPressure: isMemCritical,
                isUnderStoragePressure: this._isStorageCritical
            };
        }
    }
}

