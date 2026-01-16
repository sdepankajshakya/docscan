import { Injectable } from '@angular/core';
import { Camera, CameraResultType, CameraSource, Photo } from '@capacitor/camera';

/**
 * Service to handle document capture and image processing.
 * Responsible for interfacing with the Camera plugin and performing
 * canvas-based manipulations like grayscale and thresholding.
 */
@Injectable({
    providedIn: 'root'
})
export class DocumentProcessingService {

    constructor() { }

    /**
     * Captures a photo using the device camera.
     * @returns Promise<Photo> The captured photo object containing the dataUrl.
     */
    async takePhoto(): Promise<Photo> {
        return await Camera.getPhoto({
            quality: 90,
            resultType: CameraResultType.DataUrl,
            source: CameraSource.Camera,
        });
    }

    /**
     * Loads an image from a Data URL into a canvas element.
     * Resizes the canvas to fit the image (max width 1080px) and returns the original image data.
     * 
     * @param canvas The HTMLCanvasElement to draw on.
     * @param dataUrl The base64 data URL of the image.
     * @returns Promise containing the original and working ImageDatas.
     */
    loadImageToCanvas(canvas: HTMLCanvasElement, dataUrl: string): Promise<{ original: ImageData, working: ImageData }> {
        return new Promise((resolve, reject) => {
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject('Could not get canvas context');
                return;
            }

            const img = new Image();
            img.src = dataUrl;

            img.onload = () => {
                const MAX_WIDTH = 1080;
                const scale = Math.min(1, MAX_WIDTH / img.width);

                canvas.width = img.width * scale;
                canvas.height = img.height * scale;

                const ctx = canvas.getContext('2d')!;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                const original = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const working = ctx.getImageData(0, 0, canvas.width, canvas.height);
                resolve({ original, working });
            };
            img.onerror = (err) => reject(err);
        });
    }

    /**
     * Applies a specific image filter to the canvas.
     * Always starts from the original image data to prevent quality degradation.
     * 
     * @param canvas The canvas to apply the filter to.
     * @param filter The type of filter to apply ('original', 'grayscale', 'adaptive-threshold').
     * @param originalData The original, unmodified ImageData.
     */
    applyFilter(
        canvas: HTMLCanvasElement,
        filter: 'original' | 'grayscale' | 'adaptive-threshold',
        originalData: ImageData
    ): void {
        const ctx = canvas.getContext('2d');
        if (!ctx || !originalData) return;

        // Reset to original first to avoid cumulative errors
        const workingData = new ImageData(
            new Uint8ClampedArray(originalData.data),
            originalData.width,
            originalData.height
        );

        if (filter === 'original') {
            ctx.putImageData(originalData, 0, 0);
            return;
        }

        const data = workingData.data;

        if (filter === 'grayscale') {
            for (let i = 0; i < data.length; i += 4) {
                const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
                data[i] = data[i + 1] = data[i + 2] = gray;
            }
        } else if (filter === 'adaptive-threshold') {
            this.applyAdaptiveThreshold(workingData, originalData.width, originalData.height);
        }

        ctx.putImageData(workingData, 0, 0);
    }

    /**
     * Applies an adaptive thresholding algorithm to convert the image to binary (B&W).
     * Useful for enhancing text in documents.
     * 
     * @param imageData The ImageData object to process.
     * @param width Width of the image.
     * @param height Height of the image.
     */
    private applyAdaptiveThreshold(imageData: ImageData, width: number, height: number) {
        const data = imageData.data;
        const grayValues = new Uint8ClampedArray(width * height);

        // Convert to grayscale first
        for (let i = 0; i < data.length; i += 4) {
            grayValues[i / 4] = (data[i] + data[i + 1] + data[i + 2]) / 3;
        }

        const windowSize = 15;
        const halfWindow = Math.floor(windowSize / 2);
        const C = 10;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let sum = 0;
                let count = 0;
                for (let wy = y - halfWindow; wy <= y + halfWindow; wy++) {
                    if (wy < 0 || wy >= height) continue;
                    for (let wx = x - halfWindow; wx <= x + halfWindow; wx++) {
                        if (wx < 0 || wx >= width) continue;
                        sum += grayValues[wy * width + wx];
                        count++;
                    }
                }
                const localMean = sum / count;
                const pixelGray = grayValues[y * width + x];
                const val = pixelGray < (localMean - C) ? 0 : 255;

                const idx = (y * width + x) * 4;
                data[idx] = data[idx + 1] = data[idx + 2] = val;
            }
        }
    }
}
