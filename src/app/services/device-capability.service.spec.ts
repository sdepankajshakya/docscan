import { TestBed } from '@angular/core/testing';
import { DeviceCapabilityService } from './device-capability.service';

describe('DeviceCapabilityService', () => {
    let service: DeviceCapabilityService;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [DeviceCapabilityService]
        });
        service = TestBed.inject(DeviceCapabilityService);
    });

    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    it('should detect a valid device tier', () => {
        const tier = service.detectTier();
        expect(['low', 'mid', 'high']).toContain(tier);
    });

    it('should return adaptive config with strictly high export quality', () => {
        const config = service.getAdaptiveConfig();
        expect(config).toBeTruthy();
        expect(config.exportQuality).toBe(0.95); // Requirement 8: Never silently reduce export quality
        expect(config.maxCacheEntries).toBeGreaterThanOrEqual(2);
        expect(config.previewResolution).toBeGreaterThanOrEqual(1000);
        expect(config.thumbnailResolution).toBeGreaterThanOrEqual(140);
    });

    it('should retrieve memory info if available', () => {
        const memory = service.getMemoryInfo();
        expect(memory.hardwareConcurrency).toBeGreaterThan(0);
    });

    it('should adapt configuration when memory pressure is critical', () => {
        spyOn(service, 'isMemoryPressureCritical').and.returnValue(true);
        const config = service.getAdaptiveConfig();
        expect(config.tier).toBe('low');
        expect(config.maxCacheEntries).toBe(2);
        expect(config.isUnderMemoryPressure).toBeTrue();
        expect(config.exportQuality).toBe(0.95); // Quality preserved even under pressure
    });
});

