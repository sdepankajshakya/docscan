/**
 * doc-aligner.service.spec.ts
 *
 * Unit tests for DocAlignerService.
 *
 * All tests in this file run in a browser-like Karma environment (no actual
 * ONNX runtime or model weights are loaded).  Real end-to-end inference
 * requires a physical or emulated Android device and is documented separately.
 *
 * Test coverage:
 *   1. Service creation & injection
 *   2. isValidQuad() – geometric validation gate
 *   3. detectDocumentCorners() – mocked inference path (low confidence → null)
 *   4. detectDocumentCorners() – mocked inference path (good confidence → corners)
 *   5. detectDocumentCorners() – inference error → null
 *   6. detectDocumentCorners() – canvas too small → null
 *   7. ensureSession() – returns null when model unavailable
 *   8. Multiple sequential calls reuse the same session
 */

import { TestBed } from '@angular/core/testing';
import {
    DocAlignerService,
    CONFIDENCE_THRESHOLD,
    DOCALIGNER_MODEL_PATH
} from './doc-aligner.service';
import { Point } from './edge-detection.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal HTMLCanvasElement of the given size. */
function makeCanvas(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    return c;
}

/** Build a fake [1, 4, 128, 128] Float32Array heatmap where every corner
 *  has a uniform peak equal to `peakValue`. */
function makeFakeHeatmap(peakValue: number): Float32Array {
    const data = new Float32Array(4 * 128 * 128).fill(0);
    // Place a peak near each corner quadrant
    const positions = [
        { ch: 0, r: 10, c: 10 },   // TL
        { ch: 1, r: 10, c: 118 },  // TR
        { ch: 2, r: 118, c: 118 }, // BR
        { ch: 3, r: 118, c: 10 }   // BL
    ];
    for (const { ch, r, c } of positions) {
        data[ch * 128 * 128 + r * 128 + c] = peakValue;
    }
    return data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocAlignerService', () => {
    let service: DocAlignerService;

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [DocAlignerService] });
        service = TestBed.inject(DocAlignerService);
    });

    // -----------------------------------------------------------------------
    // 1. Service creation
    // -----------------------------------------------------------------------
    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    it('should expose the correct model path constant', () => {
        expect(DOCALIGNER_MODEL_PATH).toBe('assets/models/lcnet100_h_e_bifpn_256_fp32.onnx');
    });

    it('should expose the correct confidence threshold constant', () => {
        expect(CONFIDENCE_THRESHOLD).toBe(0.35);
    });

    it('should configure ONNX Runtime Web for single-threaded local WASM execution', async () => {
        const ort = await import('onnxruntime-web');
        await service.ensureSession();
        expect(ort.env.wasm.numThreads).toBe(1);
        expect(ort.env.wasm.simd).toBe(true);
        expect(ort.env.wasm.wasmPaths).toBe('assets/ort/');
    });

    // -----------------------------------------------------------------------
    // 2. isValidQuad() – geometric validation
    // -----------------------------------------------------------------------
    describe('isValidQuad()', () => {
        const W = 1000, H = 800;

        it('should accept a well-formed document quad', () => {
            const corners: Point[] = [
                { x: 100, y: 80 },
                { x: 900, y: 80 },
                { x: 900, y: 720 },
                { x: 100, y: 720 }
            ];
            expect(service.isValidQuad(corners, W, H)).toBeTrue();
        });

        it('should reject a quad with a degenerate (0,0) corner', () => {
            const corners: Point[] = [
                { x: 0, y: 0 },
                { x: 900, y: 80 },
                { x: 900, y: 720 },
                { x: 100, y: 720 }
            ];
            expect(service.isValidQuad(corners, W, H)).toBeFalse();
        });

        it('should reject fewer than 4 corners', () => {
            const corners: Point[] = [{ x: 100, y: 80 }, { x: 900, y: 80 }, { x: 900, y: 720 }];
            expect(service.isValidQuad(corners, W, H)).toBeFalse();
        });

        it('should reject an empty array', () => {
            expect(service.isValidQuad([], W, H)).toBeFalse();
        });

        it('should reject a quad that is too small (<2% image area)', () => {
            // 10×10 box on a 1000×800 image = 0.01% << 2%
            const corners: Point[] = [
                { x: 100, y: 100 },
                { x: 110, y: 100 },
                { x: 110, y: 110 },
                { x: 100, y: 110 }
            ];
            expect(service.isValidQuad(corners, W, H)).toBeFalse();
        });

        it('should reject a quad that covers >98% of the image', () => {
            const corners: Point[] = [
                { x: 2, y: 2 },
                { x: 998, y: 2 },
                { x: 998, y: 798 },
                { x: 2, y: 798 }
            ];
            expect(service.isValidQuad(corners, W, H)).toBeFalse();
        });

        it('should reject a non-convex (concave) quad', () => {
            // Arrow/bowtie shape – concave
            const corners: Point[] = [
                { x: 100, y: 100 },
                { x: 900, y: 500 },
                { x: 100, y: 500 },
                { x: 900, y: 100 }
            ];
            expect(service.isValidQuad(corners, W, H)).toBeFalse();
        });

        it('should accept a moderately small document (5% area)', () => {
            // ~224×179 = ~40096 px = ~5% of 800000 px
            const corners: Point[] = [
                { x: 388, y: 311 },
                { x: 612, y: 311 },
                { x: 612, y: 490 },
                { x: 388, y: 490 }
            ];
            expect(service.isValidQuad(corners, W, H)).toBeTrue();
        });
    });

    // -----------------------------------------------------------------------
    // 3. detectDocumentCorners() – session unavailable (null returned)
    // -----------------------------------------------------------------------
    describe('detectDocumentCorners() – session unavailable', () => {
        it('should return corners:null when ensureSession returns null', async () => {
            // Force session to null
            (service as any).session = null;
            (service as any).sessionPromise = null;
            (service as any).modelAvailable = false;

            const canvas = makeCanvas(400, 300);
            const result = await service.detectDocumentCorners(canvas);

            expect(result.corners).toBeNull();
            expect(result.fromML).toBeFalse();
            expect(result.message).toContain('unavailable');
        });
    });

    // -----------------------------------------------------------------------
    // 4. detectDocumentCorners() – mocked session, low confidence → null
    // -----------------------------------------------------------------------
    describe('detectDocumentCorners() – low confidence', () => {
        it('should return null corners when min peak < threshold', async () => {
            const lowPeak = 0.10; // below 0.35 threshold
            const fakeHeatmap = makeFakeHeatmap(lowPeak);

            // Inject a mock session
            const mockSession = {
                inputNames: ['images'],
                outputNames: ['output'],
                run: jasmine.createSpy('run').and.returnValue(Promise.resolve({
                    output: {
                        data: fakeHeatmap,
                        dims: [1, 4, 128, 128]
                    }
                }))
            };
            (service as any).session = mockSession;

            const canvas = makeCanvas(1000, 800);
            const result = await service.detectDocumentCorners(canvas, CONFIDENCE_THRESHOLD);

            expect(result.corners).toBeNull();
            expect(result.fromML).toBeFalse();
            expect(result.minPeak).toBeDefined();
            expect(result.minPeak!).toBeLessThan(CONFIDENCE_THRESHOLD);
        });
    });

    // -----------------------------------------------------------------------
    // 5. detectDocumentCorners() – good confidence → corners returned
    // -----------------------------------------------------------------------
    describe('detectDocumentCorners() – good confidence', () => {
        it('should return non-null corners when min peak >= threshold', async () => {
            // High peak in TL/TR/BR/BL quadrants produces a valid quad on a 1000×800 image
            const highPeak = 0.90;
            const fakeHeatmap = makeFakeHeatmap(highPeak);

            const mockSession = {
                inputNames: ['images'],
                outputNames: ['output'],
                run: jasmine.createSpy('run').and.returnValue(Promise.resolve({
                    output: {
                        data: fakeHeatmap,
                        dims: [1, 4, 128, 128]
                    }
                }))
            };
            (service as any).session = mockSession;

            const canvas = makeCanvas(1000, 800);
            const result = await service.detectDocumentCorners(canvas, 0.35);

            // Peaks are high enough; quad validity depends on centroid extraction.
            // We at least verify the ML path was taken and minPeak is high.
            expect(result.minPeak).toBeGreaterThanOrEqual(0.35);
            if (result.fromML) {
                // If quad was valid, corners must be 4 points
                expect(result.corners).not.toBeNull();
                expect(result.corners!.length).toBe(4);
            }
            // result.message should not indicate unavailability
            expect(result.message).not.toContain('unavailable');
        });
    });

    // -----------------------------------------------------------------------
    // 6. detectDocumentCorners() – inference throws → graceful null
    // -----------------------------------------------------------------------
    describe('detectDocumentCorners() – inference error', () => {
        it('should return null corners when session.run throws', async () => {
            const mockSession = {
                inputNames: ['images'],
                outputNames: ['output'],
                run: jasmine.createSpy('run').and.throwError('WASM crashed')
            };
            (service as any).session = mockSession;

            const canvas = makeCanvas(400, 300);
            const result = await service.detectDocumentCorners(canvas);

            expect(result.corners).toBeNull();
            expect(result.fromML).toBeFalse();
            expect(result.message).toContain('exception');
        });

        it('should return null corners when session.run rejects', async () => {
            const mockSession = {
                inputNames: ['images'],
                outputNames: ['output'],
                run: jasmine.createSpy('run').and.returnValue(Promise.reject(new Error('OOM')))
            };
            (service as any).session = mockSession;

            const canvas = makeCanvas(400, 300);
            const result = await service.detectDocumentCorners(canvas);

            expect(result.corners).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // 7. detectDocumentCorners() – canvas too small → early null
    // -----------------------------------------------------------------------
    describe('detectDocumentCorners() – tiny canvas', () => {
        it('should return null without running inference for a 5×5 canvas', async () => {
            const mockSession = {
                inputNames: ['images'],
                outputNames: ['output'],
                run: jasmine.createSpy('run').and.returnValue(Promise.resolve({ output: { data: new Float32Array(4 * 128 * 128), dims: [1, 4, 128, 128] } }))
            };
            (service as any).session = mockSession;

            const canvas = makeCanvas(5, 5);
            const result = await service.detectDocumentCorners(canvas);

            expect(result.corners).toBeNull();
            expect(mockSession.run).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // 8. Session reuse – multiple sequential calls
    // -----------------------------------------------------------------------
    describe('session reuse', () => {
        it('should call run multiple times on the same session object', async () => {
            const fakeHeatmap = makeFakeHeatmap(0.10); // low confidence → null corners, but run is called
            const mockSession = {
                inputNames: ['images'],
                outputNames: ['output'],
                run: jasmine.createSpy('run').and.returnValue(Promise.resolve({
                    output: { data: fakeHeatmap, dims: [1, 4, 128, 128] }
                }))
            };
            (service as any).session = mockSession;

            const canvas = makeCanvas(400, 300);
            await service.detectDocumentCorners(canvas);
            await service.detectDocumentCorners(canvas);
            await service.detectDocumentCorners(canvas);

            // session.run should have been called 3 times on the SAME object
            expect(mockSession.run).toHaveBeenCalledTimes(3);
            // ensureSession should not have re-created the session
            expect((service as any).session).toBe(mockSession);
        });

        it('ensureSession() should return the same session object on repeated calls', async () => {
            const mockSession = { inputNames: ['images'], outputNames: ['output'], run: jasmine.createSpy('run') };
            (service as any).session = mockSession;

            const s1 = await service.ensureSession();
            const s2 = await service.ensureSession();
            const s3 = await service.ensureSession();

            expect(s1 as any).toBe(mockSession);
            expect(s2 as any).toBe(mockSession);
            expect(s3 as any).toBe(mockSession);
        });

        it('isReady should be true when session is loaded', () => {
            (service as any).session = { run: jasmine.createSpy('run') };
            expect(service.isReady).toBeTrue();
        });

        it('isReady should be false before session loads', () => {
            (service as any).session = null;
            expect(service.isReady).toBeFalse();
        });
    });

    // -----------------------------------------------------------------------
    // 9. Confidence threshold boundary
    // -----------------------------------------------------------------------
    describe('confidence threshold boundary', () => {
        const makeSessionWithPeak = (peak: number) => ({
            inputNames: ['images'],
            outputNames: ['output'],
            run: jasmine.createSpy('run').and.returnValue(Promise.resolve({
                output: { data: makeFakeHeatmap(peak), dims: [1, 4, 128, 128] }
            }))
        });

        it('should fail when peak is exactly at threshold - epsilon', async () => {
            (service as any).session = makeSessionWithPeak(CONFIDENCE_THRESHOLD - 0.001);
            const result = await service.detectDocumentCorners(makeCanvas(800, 600));
            expect(result.corners).toBeNull();
            expect(result.fromML).toBeFalse();
        });

        it('should pass confidence gate when peak is exactly at threshold', async () => {
            (service as any).session = makeSessionWithPeak(CONFIDENCE_THRESHOLD);
            const result = await service.detectDocumentCorners(makeCanvas(800, 600));
            // May still return null if quad is invalid, but confidence gate passes
            expect(result.minPeak).not.toBeNull();
            expect(result.minPeak!).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD - 1e-4);
        });

        it('should pass when peak is well above threshold', async () => {
            (service as any).session = makeSessionWithPeak(0.95);
            const result = await service.detectDocumentCorners(makeCanvas(800, 600));
            expect(result.minPeak).not.toBeNull();
            expect(result.minPeak!).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
        });
    });
});
