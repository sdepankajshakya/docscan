import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource, Photo } from '@capacitor/camera';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { EdgeDetectionService } from './edge-detection.service';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';

// Configure PDF.js worker - use local file instead of CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/pdf.worker.min.js';

/**
 * Service to handle document capture and image processing.
 * Responsible for interfacing with the Camera plugin and performing
 * canvas-based manipulations like grayscale and thresholding.
 * Also handles PDF processing and generation.
 * Includes OpenCV.js-based edge detection for document scanning.
 */

export interface ScannedDocument {
    name: string;
    date: string;
    thumbnail: string | null;
    fullImage?: string;
    type?: 'image' | 'pdf';
}

export interface ActiveDocumentState {
    image: string; // Data URL for single image
    images?: string[]; // Data URLs for multiple pages
    originalName?: string;
    originalDoc?: ScannedDocument;
}

export interface EdgeDetectionState {
    imageData: string;
    detectedCorners?: Array<{ x: number; y: number }>;
    originalName?: string;
}

@Injectable({
    providedIn: 'root'
})
export class DocumentProcessingService {

    private edgeDetectionService = inject(EdgeDetectionService);

    // State management
    private _documents: ScannedDocument[] = [];
    private _activeDocument: ActiveDocumentState | null = null;
    private _edgeDetectionState: EdgeDetectionState | null = null;

    constructor() { }

    // Document State Methods
    get documents(): ScannedDocument[] {
        return this._documents;
    }

    async loadDocuments() {
        const { value } = await Preferences.get({ key: 'saved_documents' });
        if (value) {
            this._documents = JSON.parse(value);

            // REVERSE MIGRATION: 
            // If we find file paths (from the failed experiment), read them back into Base64
            // so everything is consistent and "as it was".
            let repairNeeded = false;

            for (const doc of this._documents) {
                // Repair Thumbnail
                if (doc.thumbnail && !doc.thumbnail.startsWith('data:')) {
                    try {
                        const data = await Filesystem.readFile({
                            path: doc.thumbnail,
                            directory: Directory.Data
                        });
                        // Capacitor readFile returns base64 content in .data
                        doc.thumbnail = `data:image/jpeg;base64,${data.data}`;
                        repairNeeded = true;
                    } catch (e) {
                        console.warn('Could not restore thumbnail', doc.name);
                        // Keep broken reference or null? better null
                        doc.thumbnail = null;
                    }
                }

                // Repair Full Image
                if (doc.fullImage && !doc.fullImage.startsWith('data:')) {
                    try {
                        const data = await Filesystem.readFile({
                            path: doc.fullImage,
                            directory: Directory.Data
                        });
                        const ext = doc.type === 'pdf' ? 'pdf' : 'jpeg';
                        const prefix = doc.type === 'pdf' ? 'data:application/pdf;base64,' : 'data:image/jpeg;base64,';
                        doc.fullImage = `${prefix}${data.data}`;
                        repairNeeded = true;
                    } catch (e) {
                        console.warn('Could not restore image', doc.name);
                    }
                }
            }

            if (repairNeeded) {
                console.log('Restored documents from filesystem to internal storage.');
                this.saveDocumentsList();
            }
        }
    }

    async addDocument(doc: ScannedDocument) {
        this._documents.unshift(doc);
        this.saveDocumentsList();
    }

    async updateDocument(originalDoc: ScannedDocument, newImageBase64: string, newThumbnail: string) {
        originalDoc.fullImage = newImageBase64;
        originalDoc.thumbnail = newThumbnail;
        // originalDoc.date = new Date().toLocaleString(); // Optional update date
        this.saveDocumentsList();
    }

    async deleteDocument(doc: ScannedDocument) {
        const index = this._documents.findIndex(d => d.name === doc.name && d.date === doc.date);
        if (index > -1) {
            this._documents.splice(index, 1);
            this.saveDocumentsList();
        }
    }

    async renameDocument(doc: ScannedDocument, newName: string) {
        doc.name = newName;
        this.saveDocumentsList();
    }

    async saveDocumentAs(doc: ScannedDocument, format: 'image' | 'pdf') {
        if (!doc.fullImage) return;

        // Load image if not loaded - ensure it is a full Data URL
        let imageSrc = doc.fullImage;
        if (!doc.fullImage.startsWith('data:')) {
            const loaded = await this.loadDocumentImage(doc.fullImage);
            if (loaded) imageSrc = loaded;
            else return; // Failed to load
        }

        const baseName = doc.name.replace(/\.[^/.]+$/, "");
        const uniqueSuffix = `_${Date.now()}`;
        const fileName = format === 'image' ?
            `${baseName}_saved${uniqueSuffix}.jpg` :
            `${baseName}${uniqueSuffix}.pdf`;

        // Check if platform is Web
        const isWeb = Capacitor.getPlatform() === 'web';

        if (isWeb) {
            if (format === 'pdf') {
                const pdfBlob = await this.exportAsPDF([imageSrc], baseName);
                this.downloadBlob(pdfBlob, fileName);
            } else {
                // Download image
                const link = document.createElement('a');
                link.href = imageSrc;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }
            return;
        }

        // Native Implementation
        try {
            let dataToWrite = '';

            if (format === 'pdf') {
                const pdfBlob = await this.exportAsPDF([imageSrc], baseName);
                // Convert Blob to Base64
                dataToWrite = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(pdfBlob);
                });
            } else {
                dataToWrite = imageSrc;
            }

            await Filesystem.writeFile({
                path: fileName,
                data: dataToWrite,
                directory: Directory.Documents
            });

            // Helpful log or toast could be added here if we had ToastController
            console.log(`Saved to Documents/${fileName}`);
            alert(`File saved to Documents folder as ${fileName}`);

        } catch (error) {
            console.error('Error saving to documents', error);
            alert('Failed to save file to Documents.');
        }
    }

    async saveProcessedDocument(
        images: string[],
        baseName: string,
        format: 'image' | 'pdf',
        thumbnail?: string
    ) {
        if (!images.length) return;

        // Ensure we have a valid name
        let name = baseName;
        // Strip extension if present
        name = name.replace(/\.(jpg|jpeg|png|pdf)$/i, '');

        if (format === 'pdf') {
            const pdfBlob = await this.exportAsPDF(images, name);
            const reader = new FileReader();

            return new Promise<void>((resolve, reject) => {
                reader.onloadend = async () => {
                    const base64data = reader.result as string;

                    await this.addDocument({
                        name: `${name}.pdf`,
                        date: new Date().toLocaleString(),
                        thumbnail: thumbnail || null,
                        fullImage: base64data,
                        type: 'pdf'
                    });
                    resolve();
                };
                reader.onerror = reject;
                reader.readAsDataURL(pdfBlob);
            });
        } else {
            // Save as Image (First page only for now if multiple?)
            // Usually we save single image
            await this.addDocument({
                name: `${name}.jpg`,
                date: new Date().toLocaleString(),
                thumbnail: thumbnail || null,
                fullImage: images[0],
                type: 'image'
            });
        }
    }

    private async saveDocumentsList() {
        await Preferences.set({
            key: 'saved_documents',
            value: JSON.stringify(this._documents)
        });
    }

    async loadDocumentImage(filePath: string): Promise<string | null> {
        try {
            const readFile = await Filesystem.readFile({
                path: filePath,
                directory: Directory.Data
            });
            // Web returns result as dataUrl (base64) when requested?
            // Actually Capacitor result.data is base64 string
            return `data:image/jpeg;base64,${readFile.data}`;
        } catch (e) {
            console.error('Error loading image', e);
            return null;
        }
    }

    // Active Editor State Methods
    setActiveDocument(state: ActiveDocumentState) {
        this._activeDocument = state;
    }

    getActiveDocument(): ActiveDocumentState | null {
        return this._activeDocument;
    }

    clearActiveDocument() {
        this._activeDocument = null;
    }

    // Edge Detection State Methods
    setEdgeDetectionState(state: EdgeDetectionState) {
        this._edgeDetectionState = state;
    }

    getEdgeDetectionState(): EdgeDetectionState | null {
        return this._edgeDetectionState;
    }

    clearEdgeDetectionState() {
        this._edgeDetectionState = null;
    }

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
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                reject('Could not get canvas context');
                return;
            }

            const img = new Image();
            img.src = dataUrl;

            img.onload = () => {
                const MAX_WIDTH = 800; // Reduced from 1080 for faster processing
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
        filter: 'original' | 'grayscale' | 'adaptive-threshold' | 'high-contrast' | 'invert' | 'sepia' | 'brightness' | 'vibrant',
        originalData: ImageData
    ): void {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
        } else if (filter === 'high-contrast') {
            this.applyHighContrast(data);
        } else if (filter === 'invert') {
            this.applyInvert(data);
        } else if (filter === 'sepia') {
            this.applySepia(data);
        } else if (filter === 'brightness') {
            this.applyBrightness(data, 40);
        } else if (filter === 'vibrant') {
            this.applyVibrant(data);
        }

        ctx.putImageData(workingData, 0, 0);
    }

    /**
     * Applies high contrast filter - enhances contrast and converts to grayscale.
     */
    private applyHighContrast(data: Uint8ClampedArray) {
        for (let i = 0; i < data.length; i += 4) {
            // Convert to grayscale
            const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
            // Apply stronger contrast enhancement with darker bias
            const contrast = 2.2; // Increased from 1.5
            const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
            let enhanced = factor * (gray - 128) + 128;
            // Make darker by reducing brightness
            enhanced = Math.max(0, Math.min(255, enhanced - 20));
            data[i] = data[i + 1] = data[i + 2] = enhanced;
        }
    }

    /**
     * Inverts image colors (negative effect).
     */
    private applyInvert(data: Uint8ClampedArray) {
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 255 - data[i];
            data[i + 1] = 255 - data[i + 1];
            data[i + 2] = 255 - data[i + 2];
        }
    }

    /**
     * Applies sepia tone filter.
     */
    private applySepia(data: Uint8ClampedArray) {
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            data[i] = Math.min(255, (r * 0.393) + (g * 0.769) + (b * 0.189));
            data[i + 1] = Math.min(255, (r * 0.349) + (g * 0.686) + (b * 0.168));
            data[i + 2] = Math.min(255, (r * 0.272) + (g * 0.534) + (b * 0.131));
        }
    }

    /**
     * Increases brightness of the image.
     */
    private applyBrightness(data: Uint8ClampedArray, amount: number) {
        for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.min(255, data[i] + amount);
            data[i + 1] = Math.min(255, data[i + 1] + amount);
            data[i + 2] = Math.min(255, data[i + 2] + amount);
        }
    }

    /**
     * Enhances color vibrancy - good for colored documents.
     */
    private applyVibrant(data: Uint8ClampedArray) {
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // Increase saturation
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const delta = max - min;

            if (delta > 0) {
                const saturation = 1.5;
                const avg = (r + g + b) / 3;
                data[i] = Math.max(0, Math.min(255, avg + (r - avg) * saturation));
                data[i + 1] = Math.max(0, Math.min(255, avg + (g - avg) * saturation));
                data[i + 2] = Math.max(0, Math.min(255, avg + (b - avg) * saturation));
            }
        }
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

    /**
     * Processes a PDF file and converts each page to an image.
     * Calls the callback function for each page with the image data.
     * 
     * @param file The PDF file to process.
     * @param onPageProcessed Callback function called for each page with (imageDataUrl, pageNumber, totalPages).
     */
    async processPDFFile(
        file: File,
        onPageProcessed: (imageDataUrl: string, pageNum: number, totalPages: number) => void
    ): Promise<void> {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const totalPages = pdf.numPages;

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 }); // Reduced from 2.0 for faster processing

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d')!;
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({
                canvasContext: context,
                viewport: viewport,
                canvas: canvas
            }).promise;

            const imageDataUrl = canvas.toDataURL('image/jpeg', 0.8); // Reduced quality for faster processing
            onPageProcessed(imageDataUrl, pageNum, totalPages);
        }
    }

    /**
     * Exports an array of images as a PDF file.
     * 
     * @param images Array of image data URLs to include in the PDF.
     * @param filename The name of the PDF file (without extension).
     * @returns The PDF as a blob.
     */
    async exportAsPDF(images: string[], filename: string): Promise<Blob> {
        if (images.length === 0) {
            throw new Error('No images to export');
        }

        // Create a new PDF document
        const pdfDoc = await PDFDocument.create();

        for (const imageData of images) {
            // Remove data URL prefix
            const base64Data = imageData.split(',')[1];

            // Embed the image
            let image;
            if (imageData.includes('image/png')) {
                image = await pdfDoc.embedPng(base64Data);
            } else {
                image = await pdfDoc.embedJpg(base64Data);
            }

            // Add a page with the image dimensions
            const page = pdfDoc.addPage([image.width, image.height]);

            // Draw the image on the page
            page.drawImage(image, {
                x: 0,
                y: 0,
                width: image.width,
                height: image.height,
            });
        }

        // Serialize the PDF to bytes
        const pdfBytes = await pdfDoc.save();

        // Convert to Blob - create a new Uint8Array to ensure it's a proper ArrayBuffer
        return new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
    }

    /**
     * Downloads a blob as a file.
     * 
     * @param blob The blob to download.
     * @param filename The name of the file.
     */
    downloadBlob(blob: Blob, filename: string): void {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }


    private dataURLToBlob(dataURL: string): Blob {
        const arr = dataURL.split(',');
        const mime = arr[0].match(/:(.*?);/)![1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: mime });
    }

    /**
     * Detect document edges using OpenCV.js.
     * 
     * @param imageDataUrl Base64 data URL of the image.
     * @returns Promise with detected corner points or null.
     */
    async detectDocumentEdges(imageDataUrl: string): Promise<Array<{ x: number; y: number }> | null> {
        return this.edgeDetectionService.detectDocumentEdges(imageDataUrl);
    }

    /**
     * Apply perspective transform to straighten a document using OpenCV.js.
     * 
     * @param imageDataUrl Base64 data URL of the image.
     * @param corners Four corner points of the document.
     * @returns Promise with transformed image data URL or null.
     */
    async cropAndTransform(
        imageDataUrl: string,
        corners: Array<{ x: number; y: number }>
    ): Promise<string | null> {
        return this.edgeDetectionService.perspectiveTransform(imageDataUrl, corners);
    }
}
