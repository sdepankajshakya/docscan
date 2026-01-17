import { Injectable } from '@angular/core';

declare const cv: any;

@Injectable({
    providedIn: 'root'
})
export class EdgeDetectionService {
    private cvReady = false;

    constructor() {
        this.loadOpenCV();
    }

    private loadOpenCV(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (typeof cv !== 'undefined' && cv.Mat) {
                this.cvReady = true;
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
            script.async = true;
            
            script.onload = () => {
                // OpenCV.js needs a moment to initialize
                const checkCV = setInterval(() => {
                    if (typeof cv !== 'undefined' && cv.Mat) {
                        clearInterval(checkCV);
                        this.cvReady = true;
                        console.log('OpenCV.js loaded successfully');
                        resolve();
                    }
                }, 100);

                // Timeout after 10 seconds
                setTimeout(() => {
                    clearInterval(checkCV);
                    reject(new Error('OpenCV.js failed to initialize'));
                }, 10000);
            };

            script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
            document.head.appendChild(script);
        });
    }

    /**
     * Detect document edges in an image using Canny edge detection and contour finding.
     * 
     * @param imageDataUrl Base64 data URL of the image
     * @returns Array of 4 corner points or null if detection fails
     */
    async detectDocumentEdges(imageDataUrl: string): Promise<Array<{ x: number; y: number }> | null> {
        if (!this.cvReady) {
            await this.loadOpenCV();
        }

        return new Promise((resolve) => {
            try {
                const img = new Image();
                img.src = imageDataUrl;

                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d')!;
                    ctx.drawImage(img, 0, 0);

                    // Create OpenCV Mat from canvas
                    const src = cv.imread(canvas);
                    const gray = new cv.Mat();
                    const blur = new cv.Mat();
                    const edges = new cv.Mat();
                    const contours = new cv.MatVector();
                    const hierarchy = new cv.Mat();

                    // Convert to grayscale
                    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

                    // Apply Gaussian blur
                    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

                    // Apply Canny edge detection
                    cv.Canny(blur, edges, 75, 200);

                    // Find contours
                    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

                    // Find the largest contour
                    let maxArea = 0;
                    let maxContourIndex = -1;

                    for (let i = 0; i < contours.size(); i++) {
                        const contour = contours.get(i);
                        const area = cv.contourArea(contour);

                        if (area > maxArea) {
                            maxArea = area;
                            maxContourIndex = i;
                        }
                    }

                    let corners: Array<{ x: number; y: number }> | null = null;

                    if (maxContourIndex >= 0) {
                        const contour = contours.get(maxContourIndex);
                        const perimeter = cv.arcLength(contour, true);
                        const approx = new cv.Mat();

                        // Approximate polygon
                        cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

                        // If we found a 4-sided polygon
                        if (approx.rows === 4) {
                            corners = [];
                            for (let i = 0; i < 4; i++) {
                                corners.push({
                                    x: approx.data32S[i * 2],
                                    y: approx.data32S[i * 2 + 1]
                                });
                            }
                        }

                        approx.delete();
                    }

                    // Clean up
                    src.delete();
                    gray.delete();
                    blur.delete();
                    edges.delete();
                    contours.delete();
                    hierarchy.delete();

                    resolve(corners);
                };

                img.onerror = () => resolve(null);
            } catch (error) {
                console.error('Edge detection error:', error);
                resolve(null);
            }
        });
    }

    /**
     * Apply perspective transform to straighten a document.
     * 
     * @param imageDataUrl Base64 data URL of the image
     * @param corners Four corner points in order: top-left, top-right, bottom-right, bottom-left
     * @returns Transformed image data URL or null
     */
    async perspectiveTransform(
        imageDataUrl: string,
        corners: Array<{ x: number; y: number }>
    ): Promise<string | null> {
        if (!this.cvReady) {
            await this.loadOpenCV();
        }

        if (corners.length !== 4) {
            return null;
        }

        return new Promise((resolve) => {
            try {
                const img = new Image();
                img.src = imageDataUrl;

                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d')!;
                    ctx.drawImage(img, 0, 0);

                    // Create OpenCV Mat from canvas
                    const src = cv.imread(canvas);

                    // Order corners: top-left, top-right, bottom-right, bottom-left
                    const orderedCorners = this.orderPoints(corners);

                    // Calculate width and height of the output image
                    const widthA = Math.sqrt(
                        Math.pow(orderedCorners[2].x - orderedCorners[3].x, 2) +
                        Math.pow(orderedCorners[2].y - orderedCorners[3].y, 2)
                    );
                    const widthB = Math.sqrt(
                        Math.pow(orderedCorners[1].x - orderedCorners[0].x, 2) +
                        Math.pow(orderedCorners[1].y - orderedCorners[0].y, 2)
                    );
                    const maxWidth = Math.max(widthA, widthB);

                    const heightA = Math.sqrt(
                        Math.pow(orderedCorners[1].x - orderedCorners[2].x, 2) +
                        Math.pow(orderedCorners[1].y - orderedCorners[2].y, 2)
                    );
                    const heightB = Math.sqrt(
                        Math.pow(orderedCorners[0].x - orderedCorners[3].x, 2) +
                        Math.pow(orderedCorners[0].y - orderedCorners[3].y, 2)
                    );
                    const maxHeight = Math.max(heightA, heightB);

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

                    const resultDataUrl = outputCanvas.toDataURL('image/jpeg', 0.9);

                    // Clean up
                    src.delete();
                    dst.delete();
                    M.delete();
                    srcPoints.delete();
                    dstPoints.delete();

                    resolve(resultDataUrl);
                };

                img.onerror = () => resolve(null);
            } catch (error) {
                console.error('Perspective transform error:', error);
                resolve(null);
            }
        });
    }

    /**
     * Order points in clockwise order: top-left, top-right, bottom-right, bottom-left
     */
    private orderPoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
        // Sort by y-coordinate
        const sorted = points.slice().sort((a, b) => a.y - b.y);

        // Top two points
        const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
        // Bottom two points
        const bottom = sorted.slice(2, 4).sort((a, b) => a.x - b.x);

        return [
            top[0],      // top-left
            top[1],      // top-right
            bottom[1],   // bottom-right
            bottom[0]    // bottom-left
        ];
    }
}
