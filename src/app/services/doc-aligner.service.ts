import { Injectable } from '@angular/core';
import type { InferenceSession } from 'onnxruntime-web';
import { Point } from './edge-detection.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the ONNX model, served from src/assets/models/ */
export const DOCALIGNER_MODEL_PATH = 'assets/models/lcnet100_h_e_bifpn_256_fp32.onnx';

/**
 * Minimum heatmap peak confidence required for any single corner.
 * At threshold 0.35, the hybrid achieves 119/130 (91.5%) on the benchmark.
 * The plateau is flat from 0.20 to 0.40; 0.35 sits safely in the centre.
 */
export const CONFIDENCE_THRESHOLD = 0.35;

/** Model input resolution (fixed by training). */
const MODEL_INPUT_SIZE = 256;

/** Intermediate heatmap resolution for subpixel extraction (49× faster than full-res). */
const HEATMAP_INTERP_SIZE = 512;

/** Minimum fraction of image area a valid quad must cover (2%). */
const MIN_AREA_RATIO = 0.02;

/** Maximum fraction of image area a valid quad may cover (98%). */
const MAX_AREA_RATIO = 0.98;

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** Result returned by detectDocumentCorners(). */
export interface DocAlignerResult {
    /** Detected corner coordinates in original-image pixels, or null. */
    corners: Point[] | null;
    /**
     * Minimum peak heatmap confidence across all four corners (0–1).
     * null when inference did not produce usable output.
     */
    minPeak: number | null;
    /** Whether DocAligner ML produced these corners (false = OpenCV fallback). */
    fromML: boolean;
    /** Whether the result came from the OpenCV fallback path. */
    isOpenCVFallback: boolean;
    /** Diagnostic message for logging. */
    message: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * DocAlignerService loads a DocAligner LCNet100 ONNX model into ONNX Runtime Web
 * and exposes a `detectDocumentCorners()` method that returns four corner points.
 *
 * The session is loaded once and reused across all subsequent calls.
 * If model loading or inference fails the service returns null corners so the
 * caller can transparently fall back to the OpenCV detector.
 *
 * Preprocessing matches the official DocAligner/Capybara convention exactly:
 *   • Direct bilinear resize to 256×256 (no padding or letterbox)
 *   • BGR channel order (OpenCV convention)
 *   • Pixel values scaled to [0, 1] by dividing by 255.0
 *
 * Postprocessing uses a 512×512 intermediate grid (49× faster than full-res
 * resize with <0.08% coordinate error) for subpixel centroid extraction.
 */
@Injectable({
    providedIn: 'root'
})
export class DocAlignerService {

    private session: InferenceSession | null = null;
    private sessionPromise: Promise<InferenceSession | null> | null = null;
    private modelAvailable = true; // set false on permanent load failure

    constructor() {
        // Eagerly start loading in the background; errors are swallowed here
        // because detectDocumentCorners() handles them.
        this.ensureSession().catch(() => {});
    }

    // -----------------------------------------------------------------------
    // Session management
    // -----------------------------------------------------------------------

    /**
     * Ensure the ONNX session is loaded.  Returns the session or null if the
     * model is unavailable (network error, WASM unsupported, etc.).
     */
    async ensureSession(): Promise<InferenceSession | null> {
        if (!this.modelAvailable) return null;
        if (this.session) return this.session;

        if (!this.sessionPromise) {
            this.sessionPromise = this.loadSession();
        }

        this.session = await this.sessionPromise;
        return this.session;
    }

    private async loadSession(): Promise<InferenceSession | null> {
        try {
            // Dynamic import keeps ort out of the main bundle for browsers that
            // don't support WASM, and avoids SSR issues during unit tests.
            const ort = await import('onnxruntime-web');

            // Prefer WASM SIMD (single-threaded to avoid SharedArrayBuffer
            // COOP/COEP requirement inside Capacitor WebView).
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.simd = true;

            // Point to the WASM binary bundled inside assets/ so the app works
            // fully offline (no CDN dependency).
            ort.env.wasm.wasmPaths = 'assets/ort/';

            const session = await ort.InferenceSession.create(DOCALIGNER_MODEL_PATH, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
            });

            console.log('[DocAligner] ONNX session loaded. Input:', session.inputNames, 'Output:', session.outputNames);
            return session;
        } catch (err) {
            console.error('[DocAligner] Failed to load ONNX session:', err);
            this.modelAvailable = false;
            this.sessionPromise = null; // allow retry next call if transient
            return null;
        }
    }

    /** Returns true once the model has been loaded successfully. */
    get isReady(): boolean {
        return this.session !== null;
    }

    // -----------------------------------------------------------------------
    // Public inference API
    // -----------------------------------------------------------------------

    /**
     * Detect document corners in the supplied HTMLCanvasElement.
     *
     * The caller must supply a canvas that already has the image drawn at its
     * natural resolution.  This method reads pixels, runs ONNX inference,
     * extracts four corner coordinates and returns them in original-image space.
     *
     * Returns `{ corners: null }` when:
     *   – the ONNX model is not available
     *   – any heatmap peak falls below CONFIDENCE_THRESHOLD
     *   – the resulting quad fails geometric validation
     *   – inference throws an exception
     */
    async detectDocumentCorners(
        canvas: HTMLCanvasElement,
        confidenceThreshold: number = CONFIDENCE_THRESHOLD
    ): Promise<DocAlignerResult> {

        const noResult = (msg: string, minPeak: number | null = null): DocAlignerResult => ({
            corners: null, minPeak, fromML: false, isOpenCVFallback: false, message: msg
        });

        const sess = await this.ensureSession();
        if (!sess) {
            return noResult('[DocAligner] Session unavailable; use OpenCV fallback');
        }

        const origW = canvas.width;
        const origH = canvas.height;

        if (origW < 10 || origH < 10) {
            return noResult('[DocAligner] Canvas too small');
        }

        try {
            // --- 1. Preprocess -------------------------------------------------
            const inputTensor = this.buildInputTensor(canvas);

            // --- 2. Inference --------------------------------------------------
            const inputName = sess.inputNames[0];
            const ort = await import('onnxruntime-web');
            const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
                [inputName]: new ort.Tensor('float32', inputTensor.data, inputTensor.dims)
            };
            const results = await sess.run(feeds);
            const outputName = sess.outputNames[0];
            const heatmaps = results[outputName]; // shape [1, 4, 128, 128]

            if (!heatmaps || heatmaps.dims.length < 4) {
                return noResult('[DocAligner] Unexpected output shape');
            }

            // --- 3. Postprocess ------------------------------------------------
            const { corners, peaks } = this.extractCorners(
                { data: heatmaps.data as Float32Array, dims: Array.from(heatmaps.dims) },
                origW, origH, confidenceThreshold
            );
            const minPeak = Math.min(...peaks);

            // Use small epsilon (1e-4) to account for float32 precision rounding
            if (minPeak < confidenceThreshold - 1e-4) {
                return {
                    corners: null, minPeak, fromML: false, isOpenCVFallback: false,
                    message: `[DocAligner] Low confidence (min peak ${minPeak.toFixed(3)} < ${confidenceThreshold}); use OpenCV fallback`
                };
            }

            if (!this.isValidQuad(corners, origW, origH)) {
                return {
                    corners: null, minPeak, fromML: false, isOpenCVFallback: false,
                    message: `[DocAligner] Invalid quad geometry; use OpenCV fallback`
                };
            }

            return {
                corners,
                minPeak,
                fromML: true,
                isOpenCVFallback: false,
                message: `[DocAligner] OK (min peak ${minPeak.toFixed(3)})`
            };

        } catch (err) {
            console.error('[DocAligner] Inference error:', err);
            return noResult(`[DocAligner] Inference exception: ${(err as Error).message}`);
        }
    }

    // -----------------------------------------------------------------------
    // Preprocessing
    // -----------------------------------------------------------------------

    /**
     * Produce a [1, 3, 256, 256] float32 tensor in BGR channel order.
     *
     * Official DocAligner preprocessing (from capybara/Capybara source):
     *   1. Resize to 256×256 via bilinear interpolation (no padding).
     *   2. Pixel values ÷ 255.0 → [0, 1].
     *   3. Channel layout: B, G, R (OpenCV / Capybara default).
     */
    private buildInputTensor(source: HTMLCanvasElement): { data: Float32Array; dims: number[] } {
        const resized = document.createElement('canvas');
        resized.width = MODEL_INPUT_SIZE;
        resized.height = MODEL_INPUT_SIZE;
        const ctx = resized.getContext('2d');
        if (!ctx) throw new Error('Could not create 2D context for resize canvas');
        ctx.drawImage(source, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

        const raw = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data; // RGBA
        const n = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
        const tensor = new Float32Array(3 * n);

        // Channel-first planar layout: [B-plane, G-plane, R-plane]
        for (let i = 0; i < n; i++) {
            tensor[i]       = raw[i * 4 + 2] / 255.0; // B
            tensor[n + i]   = raw[i * 4 + 1] / 255.0; // G
            tensor[2 * n + i] = raw[i * 4 + 0] / 255.0; // R
        }

        return { data: tensor, dims: [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE] };
    }

    // -----------------------------------------------------------------------
    // Postprocessing
    // -----------------------------------------------------------------------

    /**
     * Extract four corner coordinates from the [1, 4, 128, 128] heatmap tensor.
     *
     * For each corner channel:
     *   1. Find the peak activation value.
     *   2. Upscale the 128×128 heatmap to a 512×512 canvas.
     *   3. Threshold and find the centroid of the largest activation blob.
     *   4. Scale centroid coordinates to original image dimensions.
     */
    private extractCorners(
        heatmapTensor: { data: Float32Array | number[]; dims: readonly number[] | number[] },
        origW: number,
        origH: number,
        threshold: number
    ): { corners: Point[]; peaks: number[] } {
        const HM = 128; // model heatmap size
        const INTERP = HEATMAP_INTERP_SIZE;
        const scaleX = origW / INTERP;
        const scaleY = origH / INTERP;
        const data = heatmapTensor.data as Float32Array;

        const corners: Point[] = [];
        const peaks: number[] = [];

        for (let ch = 0; ch < 4; ch++) {
            const offset = ch * HM * HM;

            // Find peak
            let peak = 0;
            for (let i = 0; i < HM * HM; i++) {
                if (data[offset + i] > peak) peak = data[offset + i];
            }
            peaks.push(peak);

            // Draw heatmap to intermediate canvas for subpixel centroid extraction
            const hmCanvas = document.createElement('canvas');
            hmCanvas.width = INTERP;
            hmCanvas.height = INTERP;
            const ctx = hmCanvas.getContext('2d')!;

            // Draw small canvas first, then upscale
            const smallCanvas = document.createElement('canvas');
            smallCanvas.width = HM;
            smallCanvas.height = HM;
            const sCtx = smallCanvas.getContext('2d')!;
            const imageData = sCtx.createImageData(HM, HM);

            for (let i = 0; i < HM * HM; i++) {
                const val = Math.round(Math.min(255, Math.max(0, data[offset + i] * 255)));
                imageData.data[i * 4 + 0] = val; // R
                imageData.data[i * 4 + 1] = val; // G
                imageData.data[i * 4 + 2] = val; // B
                imageData.data[i * 4 + 3] = 255;
            }
            sCtx.putImageData(imageData, 0, 0);

            // Upscale to INTERP×INTERP
            ctx.drawImage(smallCanvas, 0, 0, INTERP, INTERP);
            const interpData = ctx.getImageData(0, 0, INTERP, INTERP).data;

            // Weighted centroid over threshold
            const threshVal = threshold * 255;
            let sumX = 0, sumY = 0, sumW = 0;
            for (let y = 0; y < INTERP; y++) {
                for (let x = 0; x < INTERP; x++) {
                    const v = interpData[(y * INTERP + x) * 4]; // R channel
                    if (v >= threshVal) {
                        sumX += x * v;
                        sumY += y * v;
                        sumW += v;
                    }
                }
            }

            if (sumW > 0) {
                corners.push({
                    x: Math.round((sumX / sumW) * scaleX),
                    y: Math.round((sumY / sumW) * scaleY)
                });
            } else {
                corners.push({ x: 0, y: 0 });
            }
        }

        return { corners, peaks };
    }

    // -----------------------------------------------------------------------
    // Geometric validation
    // -----------------------------------------------------------------------

    /**
     * Validate that the four corners form a plausible document quadrilateral:
     *   – No degenerate (0,0) corners
     *   – Strictly convex polygon
     *   – Area between 2% and 98% of the image
     *
     * Matches the validation used in the benchmark that produced 119/130.
     */
    isValidQuad(corners: Point[], imageWidth: number, imageHeight: number): boolean {
        if (!corners || corners.length !== 4) return false;

        // Check for degenerate (0,0) corners
        if (corners.some(p => p.x <= 1 && p.y <= 1)) return false;

        // Convexity check using cross products
        if (!this.isConvex(corners)) return false;

        // Area check
        const area = Math.abs(this.shoelaceArea(corners));
        const imageArea = imageWidth * imageHeight;
        const ratio = area / imageArea;
        if (ratio < MIN_AREA_RATIO || ratio > MAX_AREA_RATIO) return false;

        return true;
    }

    private isConvex(pts: Point[]): boolean {
        let sign = 0;
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % n];
            const c = pts[(i + 2) % n];
            const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if (cross !== 0) {
                const s = cross > 0 ? 1 : -1;
                if (sign === 0) sign = s;
                else if (sign !== s) return false;
            }
        }
        return true;
    }

    private shoelaceArea(pts: Point[]): number {
        let area = 0;
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        return area / 2;
    }
}
