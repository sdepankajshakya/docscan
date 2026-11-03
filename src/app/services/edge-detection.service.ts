import { Injectable, inject } from '@angular/core';
import { DocAlignerService } from './doc-aligner.service';

declare const cv: any;

export interface Point {
    x: number;
    y: number;
}

/**
 * Result returned by detectDocumentEdgesHybrid().
 * Includes the chosen source so callers can log or display diagnostics.
 */
export interface HybridDetectionResult {
    corners: Point[] | null;
    source: 'DocAligner' | 'OpenCV' | 'none';
    mlMinPeak: number | null;
}

interface EvaluatedQuad {
    score: number;
    corners: Point[];
    areaRatio: number;
    area: number;
    aspectRatio?: number;
    edgeSupport: number;
    directedSupport?: number;
    centerScore: number;
    orthoScore: number;
    parallelScore: number;
}

interface ContourItem {
    contour: any;
    hull: any;
    ha: number;
    rect: { x: number; y: number; width: number; height: number };
}

@Injectable({
    providedIn: 'root'
})
export class EdgeDetectionService {
    private cvReady = false;
    private static cvPromise: Promise<void> | null = null;

    private docAligner?: DocAlignerService;

    constructor() {
        try {
            this.docAligner = inject(DocAlignerService);
        } catch (_) {
            // Support direct instantiation via 'new EdgeDetectionService()' outside Angular DI
        }
        this.loadOpenCV().catch(() => {});
    }

    private loadOpenCV(): Promise<void> {
        if (typeof cv !== 'undefined' && cv.Mat) {
            this.cvReady = true;
            return Promise.resolve();
        }

        if (EdgeDetectionService.cvPromise) {
            return EdgeDetectionService.cvPromise.then(() => {
                this.cvReady = true;
            });
        }

        EdgeDetectionService.cvPromise = new Promise((resolve, reject) => {
            if (typeof cv !== 'undefined' && cv.Mat) {
                this.cvReady = true;
                resolve();
                return;
            }

            const existingScript = typeof document !== 'undefined' ?
                document.querySelector('script[src*="opencv.js"]') : null;

            if (!existingScript && typeof document !== 'undefined') {
                const script = document.createElement('script');
                script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
                script.async = true;
                script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
                document.head.appendChild(script);
            }

            const checkCV = setInterval(() => {
                if (typeof cv !== 'undefined' && cv.Mat) {
                    clearInterval(checkCV);
                    this.cvReady = true;
                    console.log('OpenCV.js loaded successfully');
                    resolve();
                }
            }, 50);

            setTimeout(() => {
                clearInterval(checkCV);
                if (typeof cv !== 'undefined' && cv.Mat) {
                    this.cvReady = true;
                    resolve();
                } else {
                    reject(new Error('OpenCV.js failed to initialize'));
                }
            }, 20000);
        });

        return EdgeDetectionService.cvPromise.then(() => {
            this.cvReady = true;
        });
    }

    /**
     * Detect document edges in an image using multi-pass edge detection,
     * convex hull polygon approximation, aligned segment merging,
     * and robust geometric confidence scoring.
     * 
     * @param imageDataUrl Base64 data URL of the image
     * @returns Array of 4 corner points in clockwise order (top-left, top-right, bottom-right, bottom-left)
     *          or null if confidence is insufficient.
     */
    async detectDocumentEdges(imageDataUrl: string): Promise<Point[] | null> {
        if (!this.cvReady) {
            await this.loadOpenCV();
        }

        return new Promise((resolve) => {
            try {
                const img = new Image();
                img.crossOrigin = 'anonymous';

                const onLoad = () => {
                    if (!img.width || !img.height) {
                        resolve(null);
                        return;
                    }

                    const matsToDelete: any[] = [];
                    const track = <T>(m: T): T => {
                        matsToDelete.push(m);
                        return m;
                    };

                    try {
                        const origWidth = img.width;
                        const origHeight = img.height;

                        // Downscale for consistent edge detection performance and noise reduction
                        const maxDim = 800;
                        const scale = Math.min(1.0, maxDim / Math.max(origWidth, origHeight));
                        const procWidth = Math.round(origWidth * scale);
                        const procHeight = Math.round(origHeight * scale);

                        const canvas = document.createElement('canvas');
                        canvas.width = procWidth;
                        canvas.height = procHeight;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) {
                            resolve(null);
                            return;
                        }
                        ctx.drawImage(img, 0, 0, procWidth, procHeight);

                        const procMat = track(cv.imread(canvas));
                        const w = procMat.cols;
                        const h = procMat.rows;
                        const totalArea = w * h;

                        // Convert to grayscale
                        const gray = track(new cv.Mat());
                        cv.cvtColor(procMat, gray, cv.COLOR_RGBA2GRAY);

                        // 3x3 Gaussian blur preserves fine document edges (e.g. low-contrast borders & thin receipts)
                        const blurred = track(new cv.Mat());
                        cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);

                        // Combined reference edges (sensitive + medium) for perimeter support evaluation
                        const ref1 = track(new cv.Mat());
                        const ref2 = track(new cv.Mat());
                        const refEdges = track(new cv.Mat());
                        cv.Canny(blurred, ref1, 10, 25);
                        cv.Canny(blurred, ref2, 25, 75);
                        cv.bitwise_or(ref1, ref2, refEdges);

                        // Sobel gradients for edge-normal directional alignment (Recommendation 1)
                        const gradX = track(new cv.Mat());
                        const gradY = track(new cv.Mat());
                        cv.Sobel(blurred, gradX, cv.CV_32F, 1, 0, 3);
                        cv.Sobel(blurred, gradY, cv.CV_32F, 0, 1, 3);

                        // Structuring elements for morphological operations
                        const k5 = track(cv.Mat.ones(5, 5, cv.CV_8U));
                        const k7 = track(cv.Mat.ones(7, 7, cv.CV_8U));

                        // Generate candidate binary maps using multi-pass strategies
                        const binaryPasses: { name: string; mat: any; isCanny: boolean }[] = [];

                        // Pass 1: Sensitive Canny (10, 25) - detects faint boundaries and low-contrast edges
                        {
                            const e = track(new cv.Mat());
                            cv.Canny(blurred, e, 10, 25);
                            const d = track(new cv.Mat());
                            cv.dilate(e, d, k5);
                            binaryPasses.push({ name: 'Sensitive Canny', mat: d, isCanny: true });
                        }

                        // Pass 2: Medium Canny (25, 75) - standard contrast documents
                        {
                            const e = track(new cv.Mat());
                            cv.Canny(blurred, e, 25, 75);
                            const d = track(new cv.Mat());
                            cv.dilate(e, d, k5);
                            binaryPasses.push({ name: 'Medium Canny', mat: d, isCanny: true });
                        }

                        // Pass 3: Strong Canny (45, 135) - high contrast documents with textured surrounds
                        {
                            const e = track(new cv.Mat());
                            cv.Canny(blurred, e, 45, 135);
                            const d = track(new cv.Mat());
                            cv.dilate(e, d, k5);
                            binaryPasses.push({ name: 'Strong Canny', mat: d, isCanny: true });
                        }

                        // Pass 4: Direct Otsu Binary - solid silhouette against dark/patterned/keyboard surfaces & wrinkled paper
                        {
                            const th = track(new cv.Mat());
                            cv.threshold(blurred, th, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
                            const c = track(new cv.Mat());
                            cv.morphologyEx(th, c, cv.MORPH_CLOSE, k7);
                            binaryPasses.push({ name: 'Direct Otsu', mat: c, isCanny: false });
                        }

                        // Pass 5: Direct Otsu Inverted - for dark documents on light backgrounds
                        {
                            const th = track(new cv.Mat());
                            cv.threshold(blurred, th, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
                            const c = track(new cv.Mat());
                            cv.morphologyEx(th, c, cv.MORPH_CLOSE, k7);
                            binaryPasses.push({ name: 'Direct Otsu Inv', mat: c, isCanny: false });
                        }

                        // Pass 6: Adaptive Threshold (Gaussian) for uneven lighting and strong shadows
                        {
                            const a = track(new cv.Mat());
                            cv.adaptiveThreshold(blurred, a, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 5);
                            const c = track(new cv.Mat());
                            cv.morphologyEx(a, c, cv.MORPH_CLOSE, k5);
                            binaryPasses.push({ name: 'Adaptive Thresh', mat: c, isCanny: false });
                        }

                        // Pass 7: Morphological Gradient with Otsu threshold
                        {
                            const g = track(new cv.Mat());
                            cv.morphologyEx(blurred, g, cv.MORPH_GRADIENT, k5);
                            const th = track(new cv.Mat());
                            cv.threshold(g, th, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
                            const c = track(new cv.Mat());
                            cv.morphologyEx(th, c, cv.MORPH_CLOSE, k5);
                            binaryPasses.push({ name: 'Morph Gradient', mat: c, isCanny: false });
                        }

                        const allCandidates: EvaluatedQuad[] = [];
                        const borderMargin = Math.max(10, Math.min(w, h) * 0.035);

                        const evaluateHull = (hull: any, allowRotRect: boolean) => {
                            const peri = cv.arcLength(hull, true);
                            for (let eps = 0.01; eps <= 0.08; eps += 0.005) {
                                const approx = track(new cv.Mat());
                                cv.approxPolyDP(hull, approx, eps * peri, true);

                                if (approx.rows === 4 && cv.isContourConvex(approx)) {
                                    const rawPts: Point[] = [];
                                    for (let j = 0; j < 4; j++) {
                                        rawPts.push({
                                            x: approx.data32S[j * 2],
                                            y: approx.data32S[j * 2 + 1]
                                        });
                                    }

                                    const evalRes = this.evaluateCandidate(rawPts, w, h, refEdges, gradX, gradY);
                                    if (evalRes) {
                                        allCandidates.push(evalRes);
                                    }
                                    break;
                                }
                            }

                            // Hull extreme corners: selects the actual physical corner vertices from the convex hull
                            // avoiding artificial bounding-box padding into the background
                            const extremePts = this.extractHullExtremeCorners(hull);
                            if (extremePts) {
                                const evalRes = this.evaluateCandidate(extremePts, w, h, refEdges, gradX, gradY);
                                if (evalRes) {
                                    allCandidates.push(evalRes);
                                }
                            }

                            if (allowRotRect && !extremePts) {
                                try {
                                    const rrect = cv.minAreaRect(hull);
                                    const rpts = cv.RotatedRect.points(rrect);
                                    const evalRes = this.evaluateCandidate(rpts, w, h, refEdges, gradX, gradY);
                                    if (evalRes) {
                                        allCandidates.push(evalRes);
                                    }
                                } catch (_) {}
                            }
                        };

                        for (const pass of binaryPasses) {
                            const contours = track(new cv.MatVector());
                            const hierarchy = track(new cv.Mat());
                            cv.findContours(pass.mat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

                            const validContours: ContourItem[] = [];

                            for (let i = 0; i < contours.size(); i++) {
                                const c = contours.get(i);
                                const hull = track(new cv.Mat());
                                cv.convexHull(c, hull);
                                const ha = cv.contourArea(hull);

                                // Filter contours: keep sub-segments down to 0.3% for multi-segment merging (e.g. barcode snippets, crease folds)
                                if (ha < 0.003 * totalArea || ha > 0.85 * totalArea) {
                                    continue;
                                }

                                const rect = cv.boundingRect(hull);
                                // Exclude border-touching sub-contours (e.g. arm entering frame, floor edge)
                                const touchesBorder = rect.x <= borderMargin || rect.y <= borderMargin ||
                                                      rect.x + rect.width >= w - borderMargin || rect.y + rect.height >= h - borderMargin;
                                if (!touchesBorder) {
                                    validContours.push({ contour: c, hull, ha, rect });
                                }

                                // Standalone candidate evaluation for contours >= 2% area
                                if (ha >= 0.02 * totalArea) {
                                    evaluateHull(hull, false);
                                }
                            }

                            // Merged contour segment chaining:
                            // Handles creased/folded paper or elongated receipts split across multiple segments
                            // by horizontal folds, text dividers, barcodes, finger overlaps, or bifold pages
                            if (pass.isCanny && validContours.length >= 2) {
                                const checkVertAlign = (r1: any, r2: any): boolean => {
                                    const xOverlap = Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x);
                                    const minW = Math.min(r1.width, r2.width);
                                    const maxW = Math.max(r1.width, r2.width);
                                    const minH = Math.min(r1.height, r2.height);
                                    const topRect = r1.y < r2.y ? r1 : r2;
                                    const botRect = r1.y < r2.y ? r2 : r1;
                                    const vGap = botRect.y - (topRect.y + topRect.height);
                                    const centerDistX = Math.abs((r1.x + r1.width / 2) - (r2.x + r2.width / 2));

                                    const maxAllowedGap = Math.min(35, Math.max(22, 0.45 * minH));

                                    return (minH >= 18) &&
                                           (xOverlap >= 0.50 * minW) && (centerDistX <= 0.55 * maxW) && (minW / maxW >= 0.40) &&
                                           (vGap >= -30 && vGap <= maxAllowedGap);
                                };

                                const checkHorizAlign = (r1: any, r2: any): boolean => {
                                    const yOverlap = Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y);
                                    const minH = Math.min(r1.height, r2.height);
                                    const maxH = Math.max(r1.height, r2.height);
                                    const minW = Math.min(r1.width, r2.width);
                                    const leftRect = r1.x < r2.x ? r1 : r2;
                                    const rightRect = r1.x < r2.x ? r2 : r1;
                                    const hGap = rightRect.x - (leftRect.x + leftRect.width);
                                    const centerDistY = Math.abs((r1.y + r1.height / 2) - (r2.y + r2.height / 2));

                                    const maxAllowedGap = Math.min(30, Math.max(15, 0.35 * minW));

                                    // Horizontally adjacent panels (e.g. bifold pages, open book, multi-column sheets)
                                    // must be page-like panels (not thin horizontal stripes like keyboard rows)
                                    const isPageLike1 = r1.height >= 0.60 * r1.width && r1.width >= 0.22 * r1.height;
                                    const isPageLike2 = r2.height >= 0.60 * r2.width && r2.width >= 0.22 * r2.height;

                                    return (minW >= 30) && isPageLike1 && isPageLike2 &&
                                           (yOverlap >= 0.50 * minH) && (centerDistY <= 0.40 * maxH) && (minH / maxH >= 0.45) &&
                                           (hGap >= -30 && hGap <= maxAllowedGap);
                                };

                                // Build adjacency graph for aligned segments (both vertical folds & horizontal bifold/columns)
                                const adj: number[][] = Array.from({ length: validContours.length }, () => []);
                                for (let i = 0; i < validContours.length; i++) {
                                    for (let j = i + 1; j < validContours.length; j++) {
                                        if (checkVertAlign(validContours[i].rect, validContours[j].rect) ||
                                            checkHorizAlign(validContours[i].rect, validContours[j].rect)) {
                                            adj[i].push(j);
                                            adj[j].push(i);
                                        }
                                    }
                                }

                                // Traverse connected components so that chains of 2, 3, 4, 5+ segments are completely unified
                                const visited = new Array(validContours.length).fill(false);
                                for (let i = 0; i < validContours.length; i++) {
                                    if (visited[i]) continue;
                                    const group: number[] = [];
                                    const queue: number[] = [i];
                                    visited[i] = true;
                                    while (queue.length > 0) {
                                        const curr = queue.shift()!;
                                        group.push(curr);
                                        for (const neighbor of adj[curr]) {
                                            if (!visited[neighbor]) {
                                                visited[neighbor] = true;
                                                queue.push(neighbor);
                                            }
                                        }
                                    }

                                    if (group.length >= 2) {
                                        let totalRows = 0;
                                        for (const idx of group) totalRows += validContours[idx].contour.rows;
                                        const comb = track(new cv.Mat(totalRows, 1, cv.CV_32SC2));
                                        let pIdx = 0;
                                        for (const idx of group) {
                                            const c = validContours[idx].contour;
                                            for (let k = 0; k < c.rows; k++) {
                                                comb.data32S[pIdx * 2] = c.data32S[k * 2];
                                                comb.data32S[pIdx * 2 + 1] = c.data32S[k * 2 + 1];
                                                pIdx++;
                                            }
                                        }

                                        const mergedHull = track(new cv.Mat());
                                        cv.convexHull(comb, mergedHull);
                                        const mha = cv.contourArea(mergedHull);
                                        const brect = cv.boundingRect(mergedHull);

                                        if (mha >= 0.03 * totalArea && mha <= 0.85 * totalArea) {
                                            const allowRotRect = brect.height >= 1.25 * brect.width || group.length >= 3;
                                            evaluateHull(mergedHull, allowRotRect);
                                        }
                                    }
                                }
                            }
                        }

                        // Nested candidate suppression: suppress smaller candidates enclosed inside or heavily overlapping with a larger valid candidate
                        const nonNestedCandidates: EvaluatedQuad[] = [];
                        for (let i = 0; i < allCandidates.length; i++) {
                            const candA = allCandidates[i];
                            let isNested = false;

                            const cxA = (candA.corners[0].x + candA.corners[1].x + candA.corners[2].x + candA.corners[3].x) / 4;
                            const cyA = (candA.corners[0].y + candA.corners[1].y + candA.corners[2].y + candA.corners[3].y) / 4;

                            for (let j = 0; j < allCandidates.length; j++) {
                                if (i === j) continue;
                                const candB = allCandidates[j];
                                if (candB.area > 1.15 * candA.area && candB.score >= 0.60) {
                                    let insideCount = 0;
                                    for (const pt of candA.corners) {
                                        if (this.pointInPoly(pt.x, pt.y, candB.corners)) {
                                            insideCount++;
                                        }
                                    }

                                    let candidateEnclosed = false;
                                    if (insideCount >= 3) {
                                        candidateEnclosed = true;
                                    } else {
                                        // Centroid containment & bounding box overlap test:
                                        // Catches partial crops (e.g. truncated receipt or single column) where candA is inside candB
                                        const centroidInside = this.pointInPoly(cxA, cyA, candB.corners);
                                        const minXA = Math.min(candA.corners[0].x, candA.corners[1].x, candA.corners[2].x, candA.corners[3].x);
                                        const maxXA = Math.max(candA.corners[0].x, candA.corners[1].x, candA.corners[2].x, candA.corners[3].x);
                                        const minYA = Math.min(candA.corners[0].y, candA.corners[1].y, candA.corners[2].y, candA.corners[3].y);
                                        const maxYA = Math.max(candA.corners[0].y, candA.corners[1].y, candA.corners[2].y, candA.corners[3].y);

                                        const minXB = Math.min(candB.corners[0].x, candB.corners[1].x, candB.corners[2].x, candB.corners[3].x);
                                        const maxXB = Math.max(candB.corners[0].x, candB.corners[1].x, candB.corners[2].x, candB.corners[3].x);
                                        const minYB = Math.min(candB.corners[0].y, candB.corners[1].y, candB.corners[2].y, candB.corners[3].y);
                                        const maxYB = Math.max(candB.corners[0].y, candB.corners[1].y, candB.corners[2].y, candB.corners[3].y);

                                        const interMinX = Math.max(minXA, minXB);
                                        const interMaxX = Math.min(maxXA, maxXB);
                                        const interMinY = Math.max(minYA, minYB);
                                        const interMaxY = Math.min(maxYA, maxYB);
                                        if (interMaxX > interMinX && interMaxY > interMinY) {
                                            const interArea = (interMaxX - interMinX) * (interMaxY - interMinY);
                                            const bboxA = (maxXA - minXA) * (maxYA - minYA);
                                            const overlapRatio = interArea / (bboxA + 1e-6);
                                            if (centroidInside && overlapRatio >= 0.60) {
                                                candidateEnclosed = true;
                                            }
                                        }
                                    }

                                    if (candidateEnclosed) {
                                        // Recommendation 5: Adaptive Hierarchy & Support Surface Filtering
                                        // Check if Candidate B is an outer support surface (clipboard, metal drawer,
                                        // desk extension, notebook backing) enclosing genuine document Candidate A
                                        const isSupportSurface = this.checkSupportSurface(candB, candA, gray, refEdges);
                                        if (isSupportSurface) {
                                            candB.score *= 0.65;
                                            continue;
                                        }
                                        isNested = true;
                                        break;
                                    }
                                }
                            }

                            if (!isNested) {
                                nonNestedCandidates.push(candA);
                            }
                        }

                        nonNestedCandidates.sort((a, b) => b.score - a.score);
                        const bestCandidate = nonNestedCandidates[0] || null;

                        // Return no detection if confidence is insufficient
                        if (!bestCandidate || bestCandidate.score < 0.45) {
                            console.warn('Edge detection: insufficient confidence or no document candidate found');
                            resolve(null);
                            return;
                        }

                        // Scale corners back to original image coordinates
                        const originalCorners = bestCandidate.corners.map(p => ({
                            x: Math.round(Math.max(0, Math.min(origWidth, p.x / scale))),
                            y: Math.round(Math.max(0, Math.min(origHeight, p.y / scale)))
                        }));

                        console.log('Edge detection succeeded with score:', bestCandidate.score.toFixed(3), originalCorners);
                        resolve(originalCorners);

                    } finally {
                        for (const m of matsToDelete) {
                            try {
                                m.delete();
                            } catch (_) {
                                // Ignore cleanup errors
                            }
                        }
                    }
                };

                img.onload = onLoad;
                img.onerror = () => resolve(null);
                img.src = imageDataUrl;
                if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) {
                    onLoad();
                }
            } catch (error) {
                console.error('Edge detection error:', error);
                resolve(null);
            }
        });
    }

    /**
     * Extract the four extreme corner vertices of a convex hull projected onto its principal axes.
     * Selects real physical corners from actual document edge vertices rather than an unconstrained bounding box.
     */
    private extractHullExtremeCorners(hull: any): Point[] | null {
        if (!hull || hull.rows < 4) return null;
        try {
            const rrect = cv.minAreaRect(hull);
            const angleRad = (rrect.angle * Math.PI) / 180;
            const cosA = Math.cos(angleRad);
            const sinA = Math.sin(angleRad);
            const u1 = { x: cosA, y: sinA };
            const u2 = { x: -sinA, y: cosA };

            let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
            for (let k = 0; k < hull.rows; k++) {
                const px = hull.data32S[k * 2];
                const py = hull.data32S[k * 2 + 1];
                const proj1 = px * u1.x + py * u1.y;
                const proj2 = px * u2.x + py * u2.y;
                if (proj1 < min1) min1 = proj1;
                if (proj1 > max1) max1 = proj1;
                if (proj2 < min2) min2 = proj2;
                if (proj2 > max2) max2 = proj2;
            }

            let pMin1Min2: Point | null = null;
            let pMin1Max2: Point | null = null;
            let pMax1Max2: Point | null = null;
            let pMax1Min2: Point | null = null;
            let dMin1Min2 = Infinity, dMin1Max2 = Infinity, dMax1Max2 = Infinity, dMax1Min2 = Infinity;

            for (let k = 0; k < hull.rows; k++) {
                const pt: Point = { x: hull.data32S[k * 2], y: hull.data32S[k * 2 + 1] };
                const proj1 = pt.x * u1.x + pt.y * u1.y;
                const proj2 = pt.x * u2.x + pt.y * u2.y;

                const d1 = Math.hypot(proj1 - min1, proj2 - min2);
                if (d1 < dMin1Min2) { dMin1Min2 = d1; pMin1Min2 = pt; }

                const d2 = Math.hypot(proj1 - min1, proj2 - max2);
                if (d2 < dMin1Max2) { dMin1Max2 = d2; pMin1Max2 = pt; }

                const d3 = Math.hypot(proj1 - max1, proj2 - max2);
                if (d3 < dMax1Max2) { dMax1Max2 = d3; pMax1Max2 = pt; }

                const d4 = Math.hypot(proj1 - max1, proj2 - min2);
                if (d4 < dMax1Min2) { dMax1Min2 = d4; pMax1Min2 = pt; }
            }

            if (pMin1Min2 && pMin1Max2 && pMax1Max2 && pMax1Min2) {
                return [pMin1Min2, pMin1Max2, pMax1Max2, pMax1Min2];
            }
        } catch (_) {}
        return null;
    }

    /**
     * Evaluate a candidate quadrilateral based on border clearance,
     * area coverage, corner orthogonality, side parallelism, centeredness, and edge support.
     * Prevents selecting image frames, background rectangles, or non-document objects.
     */
    private evaluateCandidate(
        rawPts: Point[],
        w: number,
        h: number,
        refEdges: any,
        gradX: any,
        gradY: any
    ): EvaluatedQuad | null {
        const totalArea = w * h;
        const ordered = this.orderPoints(rawPts);

        // 1. Border clearance: reject candidates hugging the outer photo boundary
        const borderMargin = Math.max(10, Math.min(w, h) * 0.035);
        let touchBorderCount = 0;
        for (const p of ordered) {
            if (p.x <= borderMargin || p.x >= w - borderMargin ||
                p.y <= borderMargin || p.y >= h - borderMargin) {
                touchBorderCount++;
            }
        }
        if (touchBorderCount >= 2) {
            return null;
        }

        // 2. Area coverage (Shoelace formula)
        let area = 0;
        for (let j = 0; j < 4; j++) {
            const k = (j + 1) % 4;
            area += ordered[j].x * ordered[k].y - ordered[k].x * ordered[j].y;
        }
        area = Math.abs(area) / 2;
        const areaRatio = area / totalArea;

        // Document area range: 3.5% (receipts, notes) to 82%
        if (areaRatio < 0.035 || areaRatio > 0.82) {
            return null;
        }
        // If one corner touches border, reject if it's a large background contour
        if (touchBorderCount >= 1 && areaRatio > 0.40) {
            return null;
        }

        // 3. Spanning frame rejection: reject bounding boxes covering entire frame
        let minX = w, maxX = 0, minY = h, maxY = 0;
        for (const p of ordered) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        const spanW = (maxX - minX) / w;
        const spanH = (maxY - minY) / h;
        if (spanW > 0.82 && spanH > 0.82) {
            return null;
        }

        // 4. Corner angle orthogonality (angles in perspective should be ~90 degrees)
        let maxCos = 0;
        for (let j = 0; j < 4; j++) {
            const cosA = Math.abs(this.angleCos(ordered[j], ordered[(j + 1) % 4], ordered[(j + 3) % 4]));
            if (cosA > maxCos) maxCos = cosA;
        }
        // Angles must be between ~49° and ~131°
        if (maxCos > 0.65) {
            return null;
        }

        // 5. Opposite side parallelism & ratio
        const sTop = this.dist(ordered[0], ordered[1]);
        const sRight = this.dist(ordered[1], ordered[2]);
        const sBottom = this.dist(ordered[2], ordered[3]);
        const sLeft = this.dist(ordered[3], ordered[0]);

        const opp1 = Math.min(sTop, sBottom) / Math.max(sTop, sBottom);
        const opp2 = Math.min(sLeft, sRight) / Math.max(sLeft, sRight);
        if (opp1 < 0.45 || opp2 < 0.45) {
            return null;
        }

        // 6. Aspect ratio (support receipts 1:6 up to landscape sheets 6:1)
        const avgW = (sTop + sBottom) / 2;
        const avgH = (sLeft + sRight) / 2;
        const ar = avgW / avgH;
        if (ar < 0.15 || ar > 6.5) {
            return null;
        }

        // 7. Edge support along perimeter
        let edgeSupport = this.computeEdgeSupport(ordered, refEdges);
        if (edgeSupport < 0.30) {
            return null;
        }

        // Recommendation 1: Directed Gradient & Edge-Normal Consistency Scoring
        const directedSupport = this.computeDirectedGradientSupport(ordered, gradX, gradY, w, h);
        if (directedSupport < 0.20) {
            return null; // Reject false candidates cutting across textures or non-normal seams
        }
        edgeSupport = 0.50 * edgeSupport + 0.50 * directedSupport;

        // 8. Centeredness: distance of quad centroid to image center
        const cx = (ordered[0].x + ordered[1].x + ordered[2].x + ordered[3].x) / 4;
        const cy = (ordered[0].y + ordered[1].y + ordered[2].y + ordered[3].y) / 4;
        const distFromCenter = Math.hypot(cx - w / 2, cy - h / 2) / Math.hypot(w / 2, h / 2);
        const centerScore = Math.max(0, 1 - distFromCenter * 1.5);

        const orthoScore = 1 - maxCos;
        const parallelScore = opp1 * opp2;
        // Bounded area score gives full credit to real documents without dominating smaller receipts
        const areaScore = Math.min(1.0, Math.sqrt(areaRatio / 0.12));

        // Combined score dominated by edge alignment, centeredness, and geometric regularity
        const score = (edgeSupport * 0.35) +
                      (orthoScore * 0.15) +
                      (parallelScore * 0.15) +
                      (centerScore * 0.25) +
                      (areaScore * 0.10);

        return {
            score,
            corners: ordered,
            areaRatio,
            area,
            aspectRatio: ar,
            edgeSupport,
            directedSupport,
            centerScore,
            orthoScore,
            parallelScore
        };
    }

    /**
     * Compute the fraction of points along the quadrilateral perimeter that align with detected edges.
     */
    private computeEdgeSupport(orderedPts: Point[], edgeMat: any): number {
        let hitCount = 0;
        let totalSamples = 0;
        const w = edgeMat.cols;
        const h = edgeMat.rows;

        for (let i = 0; i < 4; i++) {
            const p1 = orderedPts[i];
            const p2 = orderedPts[(i + 1) % 4];
            const len = this.dist(p1, p2);
            const steps = Math.max(10, Math.floor(len / 3));

            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                const x = Math.round(p1.x + (p2.x - p1.x) * t);
                const y = Math.round(p1.y + (p2.y - p1.y) * t);
                totalSamples++;

                let hit = false;
                for (let dy = -3; dy <= 3 && !hit; dy++) {
                    for (let dx = -3; dx <= 3; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                            if (edgeMat.ucharPtr(ny, nx)[0] > 0) {
                                hit = true;
                                break;
                            }
                        }
                    }
                }
                if (hit) hitCount++;
            }
        }
        return totalSamples > 0 ? (hitCount / totalSamples) : 0;
    }

    /**
     * Compute the fraction of points along the quadrilateral perimeter that align
     * with the directed image gradient normal vector (Sobel dx, dy).
     * Rejects false quad candidates that cut across textures, keycaps, or floor seams.
     */
    private computeDirectedGradientSupport(
        orderedPts: Point[],
        gradX: any,
        gradY: any,
        w: number,
        h: number
    ): number {
        let alignedHits = 0;
        let totalSamples = 0;

        for (let i = 0; i < 4; i++) {
            const p1 = orderedPts[i];
            const p2 = orderedPts[(i + 1) % 4];
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy);
            if (len < 1e-4) continue;

            // Unit normal vector perpendicular to the segment
            const nx = -dy / len;
            const ny = dx / len;

            const steps = Math.max(10, Math.floor(len / 3));
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                const sx = Math.round(p1.x + dx * t);
                const sy = Math.round(p1.y + dy * t);
                totalSamples++;

                // Search in a ±3px window along the normal
                let maxMag = 0;
                let bestGx = 0;
                let bestGy = 0;

                for (let d = -3; d <= 3; d++) {
                    const qx = Math.round(sx + nx * d);
                    const qy = Math.round(sy + ny * d);
                    if (qx >= 0 && qx < w && qy >= 0 && qy < h) {
                        const gx = gradX.floatPtr(qy, qx)[0];
                        const gy = gradY.floatPtr(qy, qx)[0];
                        const mag = Math.hypot(gx, gy);
                        if (mag > maxMag) {
                            maxMag = mag;
                            bestGx = gx;
                            bestGy = gy;
                        }
                    }
                }

                if (maxMag > 25.0) {
                    const dot = Math.abs((bestGx * nx + bestGy * ny) / maxMag);
                    if (dot >= 0.707) { // within 45 degrees of edge normal
                        alignedHits++;
                    }
                }
            }
        }

        return totalSamples > 0 ? (alignedHits / totalSamples) : 0;
    }

    /**
     * Check if Candidate B is an outer support surface (such as a clipboard, metal drawer opening,
     * wooden desk extension, or notebook backing) enclosing document Candidate A.
     * Evaluates margin emptiness (absence of printed document text in the region B \ A)
     * and substrate contrast step (verifying that B is a distinctly colored mounting surface
     * rather than the document's own outer white margin).
     */
    private checkSupportSurface(
        candB: EvaluatedQuad,
        candA: EvaluatedQuad,
        gray: any,
        refEdges: any
    ): boolean {
        const areaRatio = candB.area / (candA.area + 1e-5);
        // B must be moderately larger than A (1.3x to 5.5x)
        if (areaRatio < 1.30 || areaRatio > 5.5) return false;

        // A must be a substantial candidate (>= 6% total image area)
        if (candA.areaRatio < 0.06) return false;

        // A must have document-like aspect ratio (0.25 to 2.5)
        const arA = candA.aspectRatio || 1.0;
        if (arA < 0.25 || arA > 2.5) return false;

        // A must have solid edge support and score
        if (candA.score < 0.52 || candA.edgeSupport < 0.35) return false;

        // B must be large (>= 20% total area) to be a plausible support surface
        if (candB.areaRatio < 0.20) return false;

        // Sample points in B that lie outside A (the margin)
        const minXB = Math.min(...candB.corners.map(p => p.x));
        const maxXB = Math.max(...candB.corners.map(p => p.x));
        const minYB = Math.min(...candB.corners.map(p => p.y));
        const maxYB = Math.max(...candB.corners.map(p => p.y));

        let marginSamples = 0;
        let marginEdgeHits = 0;
        const stepX = Math.max(6, Math.floor((maxXB - minXB) / 12));
        const stepY = Math.max(6, Math.floor((maxYB - minYB) / 12));

        for (let y = minYB + stepY; y < maxYB; y += stepY) {
            for (let x = minXB + stepX; x < maxXB; x += stepX) {
                if (this.pointInPoly(x, y, candB.corners) && !this.pointInPoly(x, y, candA.corners)) {
                    marginSamples++;
                    if (refEdges.ucharPtr(Math.round(y), Math.round(x))[0] > 0) {
                        marginEdgeHits++;
                    }
                }
            }
        }

        if (marginSamples < 12) return false;
        const marginEdgeFrac = marginEdgeHits / marginSamples;

        // If the margin has printed text/edges (> 6%), B is a multi-section document, NOT a support surface
        if (marginEdgeFrac > 0.06) return false;

        // Support surface B must have a distinct luminance/color step from document A
        // (e.g. dark clipboard vs white paper, or dark drawer vs light paper)
        let sumLumMargin = 0;
        let sumLumA = 0;
        let countA = 0;
        let countMargin = 0;

        for (let y = minYB + stepY; y < maxYB; y += stepY) {
            for (let x = minXB + stepX; x < maxXB; x += stepX) {
                const val = gray.ucharPtr(Math.round(y), Math.round(x))[0];
                if (this.pointInPoly(x, y, candA.corners)) {
                    sumLumA += val;
                    countA++;
                } else if (this.pointInPoly(x, y, candB.corners)) {
                    sumLumMargin += val;
                    countMargin++;
                }
            }
        }

        if (countA < 8 || countMargin < 8) return false;
        const meanA = sumLumA / countA;
        const meanMargin = sumLumMargin / countMargin;
        const lumStep = Math.abs(meanA - meanMargin);

        // Support surfaces (clipboard, dark drawer, wood desk, yellow notebook) have substantial contrast step
        if (lumStep < 25.0) return false;

        return true;
    }

    private dist(p1: Point, p2: Point): number {
        return Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }

    private angleCos(p0: Point, p1: Point, p2: Point): number {
        const dx1 = p1.x - p0.x;
        const dy1 = p1.y - p0.y;
        const dx2 = p2.x - p0.x;
        const dy2 = p2.y - p0.y;
        return (dx1 * dx2 + dy1 * dy2) / (Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2) + 1e-6);
    }

    private pointInPoly(px: number, py: number, poly: Point[]): boolean {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /**
     * Order 4 points in clockwise order starting from top-left:
     * [0] top-left, [1] top-right, [2] bottom-right, [3] bottom-left
     */
    orderPoints(points: Point[]): Point[] {
        if (!points || points.length !== 4) {
            return points;
        }

        // Compute centroid
        const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
        const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;

        // Sort clockwise around centroid
        const sorted = points.slice().sort((a, b) => {
            return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
        });

        // Find top-left (point with minimum x + y)
        let minSum = Infinity;
        let tlIndex = 0;
        for (let i = 0; i < 4; i++) {
            const sum = sorted[i].x + sorted[i].y;
            if (sum < minSum) {
                minSum = sum;
                tlIndex = i;
            }
        }

        return [
            sorted[tlIndex],
            sorted[(tlIndex + 1) % 4],
            sorted[(tlIndex + 2) % 4],
            sorted[(tlIndex + 3) % 4]
        ];
    }

    /**
     * Apply perspective transform to straighten a document.
     * 
     * @param imageDataUrl Base64 data URL of the image
     * @param corners Four corner points
     * @returns Transformed image data URL or null
     */
    async perspectiveTransform(
        imageDataUrl: string,
        corners: Point[]
    ): Promise<string | null> {
        if (!this.cvReady) {
            await this.loadOpenCV();
        }

        if (!corners || corners.length !== 4) {
            return null;
        }

        return new Promise((resolve) => {
            try {
                const img = new Image();
                img.crossOrigin = 'anonymous';

                const onImageLoad = () => {
                    const imgWidth = img.naturalWidth || img.width;
                    const imgHeight = img.naturalHeight || img.height;
                    const canvas = document.createElement('canvas');
                    canvas.width = imgWidth;
                    canvas.height = imgHeight;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        resolve(null);
                        return;
                    }
                    ctx.drawImage(img, 0, 0);

                    let src: any = null;
                    let dst: any = null;
                    let M: any = null;
                    let srcPoints: any = null;
                    let dstPoints: any = null;

                    try {
                        // Create OpenCV Mat from canvas
                        src = cv.imread(canvas);

                    // Order corners: top-left, top-right, bottom-right, bottom-left
                    const orderedCorners = this.orderPoints(corners);

                    // Calculate width and height of the straightened output image
                    const widthA = Math.hypot(
                        orderedCorners[2].x - orderedCorners[3].x,
                        orderedCorners[2].y - orderedCorners[3].y
                    );
                    const widthB = Math.hypot(
                        orderedCorners[1].x - orderedCorners[0].x,
                        orderedCorners[1].y - orderedCorners[0].y
                    );
                    const maxWidth = Math.max(10, Math.round(Math.max(widthA, widthB)));

                    const heightA = Math.hypot(
                        orderedCorners[1].x - orderedCorners[2].x,
                        orderedCorners[1].y - orderedCorners[2].y
                    );
                    const heightB = Math.hypot(
                        orderedCorners[0].x - orderedCorners[3].x,
                        orderedCorners[0].y - orderedCorners[3].y
                    );
                    const maxHeight = Math.max(10, Math.round(Math.max(heightA, heightB)));

                    // Source points
                    const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
                        orderedCorners[0].x, orderedCorners[0].y,
                        orderedCorners[1].x, orderedCorners[1].y,
                        orderedCorners[2].x, orderedCorners[2].y,
                        orderedCorners[3].x, orderedCorners[3].y
                    ]);

                    // Destination points
                    const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
                        0, 0,
                        maxWidth, 0,
                        maxWidth, maxHeight,
                        0, maxHeight
                    ]);

                    // Get perspective transform matrix
                    const M = cv.getPerspectiveTransform(srcPoints, dstPoints);

                    // Apply warp perspective
                    const dst = new cv.Mat();
                    const dsize = new cv.Size(maxWidth, maxHeight);
                    cv.warpPerspective(src, dst, M, dsize);

                    // Convert back to canvas
                    const outputCanvas = document.createElement('canvas');
                    cv.imshow(outputCanvas, dst);

                    const resultDataUrl = outputCanvas.toDataURL('image/jpeg', 0.95);
                        resolve(resultDataUrl);
                    } catch (err) {
                        console.error('Error during warp perspective:', err);
                        resolve(null);
                    } finally {
                        if (src) src.delete();
                        if (dst) dst.delete();
                        if (M) M.delete();
                        if (srcPoints) srcPoints.delete();
                        if (dstPoints) dstPoints.delete();
                    }
                };

                img.onload = onImageLoad;
                img.onerror = () => resolve(null);
                img.src = imageDataUrl;
                if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) {
                    onImageLoad();
                }
            } catch (error) {
                console.error('Edge detection error:', error);
                resolve(null);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Hybrid ML + OpenCV detector (primary public API for new scans)
    // -------------------------------------------------------------------------

    /**
     * Detect document edges using the DocAligner + OpenCV hybrid pipeline.
     *
     * Decision logic (mirrors the benchmarked 119/130 configuration):
     *   1. Load the image onto a canvas.
     *   2. Run DocAligner LCNet100 ONNX inference.
     *   3. If all four corner heatmaps exceed the confidence threshold AND the
     *      resulting quad passes geometric validation → return ML corners.
     *   4. Otherwise fall back to the existing OpenCV Combination A detector.
     *
     * The method is safe to call concurrently for multiple images; each call
     * uses an independently allocated canvas and releases it when done.
     *
     * @param imageDataUrl  Base64 data URL of the source image.
     * @param confidenceThreshold  Override the default 0.35 threshold (tests only).
     * @returns HybridDetectionResult with corners and the chosen source.
     */
    async detectDocumentEdgesHybrid(
        imageDataUrl: string,
        confidenceThreshold?: number
    ): Promise<HybridDetectionResult> {

        // --- Load image onto a canvas so we can pass it to DocAligner --------
        let canvas: HTMLCanvasElement | null = null;
        let corners: Point[] | null = null;
        let mlMinPeak: number | null = null;

        try {
            canvas = await this.imageDataUrlToCanvas(imageDataUrl);
        } catch (_) {
            canvas = null;
        }

        // --- Stage 1: Try DocAligner -----------------------------------------
        if (canvas) {
            try {
                if (!this.docAligner) {
                    this.docAligner = new DocAlignerService();
                }
                const result = await this.docAligner.detectDocumentCorners(
                    canvas,
                    confidenceThreshold
                );
                mlMinPeak = result.minPeak;
                console.log(result.message);

                if (result.fromML && result.corners) {
                    this.releaseCanvas(canvas);
                    return { corners: result.corners, source: 'DocAligner', mlMinPeak };
                }
            } catch (err) {
                console.warn('[HybridDetector] DocAligner threw unexpectedly:', err);
            }
            this.releaseCanvas(canvas);
        } else {
            console.warn('[HybridDetector] Could not decode image; attempting OpenCV fallback');
        }

        // --- Stage 2: OpenCV Combination A fallback --------------------------
        corners = await this.detectDocumentEdges(imageDataUrl);

        if (corners) {
            return { corners, source: 'OpenCV', mlMinPeak };
        }

        return { corners: null, source: 'none', mlMinPeak };
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Decode a data URL onto an HTMLCanvasElement at the image's natural size.
     * Rejects if the data URL is invalid or the image fails to load.
     */
    private imageDataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            const onLoad = () => {
                const w = img.naturalWidth || img.width;
                const h = img.naturalHeight || img.height;
                if (!w || !h) {
                    reject(new Error('Image has zero dimensions'));
                    return;
                }
                const c = document.createElement('canvas');
                c.width = w;
                c.height = h;
                const ctx = c.getContext('2d');
                if (!ctx) { reject(new Error('No 2D context')); return; }
                ctx.drawImage(img, 0, 0);
                resolve(c);
            };

            img.onload = onLoad;
            img.onerror = () => reject(new Error('Image load failed'));
            img.src = dataUrl;
            if (img.complete && (img.naturalWidth !== 0 || img.width !== 0)) {
                onLoad();
            }
        });
    }

    /** Release a canvas backing store to return GPU/CPU memory. */
    private releaseCanvas(canvas: HTMLCanvasElement | null): void {
        if (!canvas) return;
        canvas.width = 0;
        canvas.height = 0;
    }
}
