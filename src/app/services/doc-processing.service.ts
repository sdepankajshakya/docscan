import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource, Photo } from '@capacitor/camera';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { EdgeDetectionService } from './edge-detection.service';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

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
    displayThumbnail?: string; // RUNTIME ONLY: Base64/Blob URL for UI
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
        try {
            const readFile = await Filesystem.readFile({
                path: 'documents.json',
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });
            if (readFile.data) {
                this._documents = JSON.parse(readFile.data as string);

                // MIGRATION: If any thumbnail is Base64, move it to a file
                let migrationNeeded = false;
                for (const doc of this._documents) {
                    if (doc.thumbnail && doc.thumbnail.startsWith('data:')) {
                        try {
                            const fileName = await this.saveThumbnailToFile(doc.thumbnail);
                            doc.thumbnail = fileName;
                            migrationNeeded = true;
                        } catch (e) {
                            console.error('Migration failed for thumbnail', e);
                        }
                    }
                }

                if (migrationNeeded) {
                    await this.saveDocumentsList();
                }

                console.log('Documents loaded from filesystem:', this._documents.length);
            }
        } catch (e) {
            console.warn('Could not load documents.json, starting fresh.', e);
            this._documents = [];
        }
    }

    async addDocument(doc: ScannedDocument) {
        // If fullImage is Base64, save to filesystem
        if (doc.fullImage && doc.fullImage.startsWith('data:')) {
            const timestamp = new Date().getTime();
            const ext = doc.type === 'pdf' ? 'pdf' : 'jpg';
            const fileName = `doc_${timestamp}_${Math.floor(Math.random() * 1000)}.${ext}`;

            try {
                await Filesystem.writeFile({
                    path: fileName,
                    data: doc.fullImage,
                    directory: Directory.Data
                });
                doc.fullImage = fileName;
            } catch (e) {
                console.error('Failed to save document file', e);
                throw e;
            }
        }

        // If thumbnail is Base64, save to filesystem
        if (doc.thumbnail && doc.thumbnail.startsWith('data:')) {
            doc.thumbnail = await this.saveThumbnailToFile(doc.thumbnail);
        }

        // Pre-load displayThumbnail so it appears immediately in the UI
        doc.displayThumbnail = await this.resolveThumbnailUrl(doc);

        this._documents.unshift(doc);
        this.saveDocumentsList();
    }

    async updateDocument(originalDoc: ScannedDocument, newImageBase64: string, newThumbnail: string) {
        let oldFile = originalDoc.fullImage;
        let oldThumb = originalDoc.thumbnail;
        const timestamp = new Date().getTime();
        const ext = originalDoc.type === 'pdf' ? 'pdf' : 'jpg';
        const fileName = `doc_${timestamp}_${Math.floor(Math.random() * 1000)}.${ext}`;

        try {
            // Save new high-res file
            await Filesystem.writeFile({
                path: fileName,
                data: newImageBase64,
                directory: Directory.Data
            });

            // Save new thumbnail file
            const thumbFileName = await this.saveThumbnailToFile(newThumbnail);

            originalDoc.fullImage = fileName;
            originalDoc.thumbnail = thumbFileName;

            // Update displayThumbnail so the new thumbnail appears immediately
            originalDoc.displayThumbnail = await this.resolveThumbnailUrl(originalDoc);

            this.saveDocumentsList();

            // Clean up old files
            if (oldFile && !oldFile.startsWith('data:')) {
                try {
                    await Filesystem.deleteFile({ path: oldFile, directory: Directory.Data });
                } catch (e) { }
            }
            if (oldThumb && !oldThumb.startsWith('data:')) {
                try {
                    await Filesystem.deleteFile({ path: oldThumb, directory: Directory.Data });
                } catch (e) { }
            }

        } catch (e) {
            console.error('Failed to update document files', e);
        }
    }

    async deleteDocument(doc: ScannedDocument) {
        // Delete full image
        if (doc.fullImage && !doc.fullImage.startsWith('data:')) {
            try {
                await Filesystem.deleteFile({ path: doc.fullImage, directory: Directory.Data });
            } catch (e) { }
        }
        // Delete thumbnail
        if (doc.thumbnail && !doc.thumbnail.startsWith('data:')) {
            try {
                await Filesystem.deleteFile({ path: doc.thumbnail, directory: Directory.Data });
            } catch (e) { }
        }

        const index = this._documents.findIndex(d => d.name === doc.name && d.date === doc.date);
        if (index > -1) {
            this._documents.splice(index, 1);
            this.saveDocumentsList();
        }
    }

    async renameDocument(doc: ScannedDocument, newName: string) {
        // ONLY update the display name. DO NOT RENAME THE FILE.
        // This makes renaming instant.
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
                if (doc.type === 'pdf' || imageSrc.startsWith('data:application/pdf')) {
                    // It's already a PDF, just download it
                    const blob = this.dataURLToBlob(imageSrc);
                    this.downloadBlob(blob, fileName);
                } else {
                    const pdfBlob = await this.exportAsPDF([imageSrc], baseName);
                    this.downloadBlob(pdfBlob, fileName);
                }
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
                if (doc.type === 'pdf' || imageSrc.startsWith('data:application/pdf')) {
                    // Already a PDF
                    dataToWrite = imageSrc;
                } else {
                    const pdfBlob = await this.exportAsPDF([imageSrc], baseName);
                    // Convert Blob to Base64
                    dataToWrite = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result as string);
                        reader.onerror = reject;
                        reader.readAsDataURL(pdfBlob);
                    });
                }
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
                fullImage: images[0], // Base64, will be converted in addDocument
                type: 'image'
            });
        }
    }

    private async saveDocumentsList() {
        try {
            await Filesystem.writeFile({
                path: 'documents.json',
                data: JSON.stringify(this._documents),
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });
        } catch (e) {
            console.error('Error saving documents list', e);
        }
    }

    async loadDocumentImage(filePath: string): Promise<string | null> {
        try {
            const readFile = await Filesystem.readFile({
                path: filePath,
                directory: Directory.Data
            });

            // Determine mime type from extension
            const ext = filePath.split('.').pop()?.toLowerCase();
            const mimeType = ext === 'pdf' ? 'application/pdf' : 'image/jpeg';

            return `data:${mimeType};base64,${readFile.data}`;
        } catch (e) {
            console.error('Error loading file', filePath, e);
            return null;
        }
    }

    /**
     * Internal helper to save a thumbnail to the filesystem.
     */
    private async saveThumbnailToFile(base64: string): Promise<string> {
        const timestamp = new Date().getTime();
        const fileName = `thumb_${timestamp}_${Math.floor(Math.random() * 1000)}.jpg`;

        await Filesystem.writeFile({
            path: fileName,
            data: base64,
            directory: Directory.Data
        });

        return fileName;
    }

    /**
     * Converts a thumbnail file path to a URL that can be used in <img> tags.
     */
    async resolveThumbnailUrl(doc: ScannedDocument): Promise<string> {
        if (!doc.thumbnail) return '';
        if (doc.thumbnail.startsWith('data:')) return doc.thumbnail;

        // Web needs Data URL because convertFileSrc is finicky with IndexedDB
        const isWeb = !Capacitor.isNativePlatform();
        if (isWeb) {
            const data = await this.loadDocumentImage(doc.thumbnail);
            return data || '';
        } else {
            // On native platforms, get the full URI first
            try {
                const uriResult = await Filesystem.getUri({
                    path: doc.thumbnail,
                    directory: Directory.Data
                });
                return Capacitor.convertFileSrc(uriResult.uri);
            } catch (e) {
                console.error('Error resolving thumbnail URI', e);
                return '';
            }
        }
    }

    /**
     * Extracts images from a base64 PDF string.
     */
    async extractPagesFromPDFData(base64Data: string): Promise<string[]> {
        // Convert base64 to Uint8Array/ArrayBuffer
        const binaryString = atob(base64Data.split(',')[1] || base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const pdf = await pdfjsLib.getDocument({ data: bytes.buffer }).promise;
        const totalPages = pdf.numPages;
        const pages: string[] = [];

        for (let i = 1; i <= totalPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2.5 }); // Increased from 1.5
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d')!;
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({
                canvasContext: context,
                viewport: viewport,
                canvas: canvas
            }).promise;

            pages.push(canvas.toDataURL('image/jpeg', 0.95)); // Increased from 0.8
        }
        return pages;
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
    loadImageToCanvas(canvas: HTMLCanvasElement, dataUrl: string, maxWidth: number = 2500): Promise<{ original: ImageData, working: ImageData }> {
        return new Promise((resolve, reject) => {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                reject('Could not get canvas context');
                return;
            }

            const img = new Image();
            img.src = dataUrl;

            img.onload = () => {
                const scale = Math.min(1, maxWidth / img.width);

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
        filter: 'original' | 'grayscale' | 'adaptive-threshold' | 'high-contrast' | 'invert' | 'sepia' | 'brightness' | 'vibrant' | 'print-bw',
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
            this.applyGrayscale(data);
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
        } else if (filter === 'print-bw') {
            this.applyPrintBW(data);
        }

        ctx.putImageData(workingData, 0, 0);
    }

    /**
     * Applies grayscale filter.
     * Uses simple average formula.
     */
    private applyGrayscale(data: Uint8ClampedArray) {
        for (let i = 0; i < data.length; i += 4) {
            // Revert to simple average as requested
            const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
            data[i] = data[i + 1] = data[i + 2] = gray;
        }
    }

    /**
     * Applies "Print B&W" filter.
     * darker text/midtones for better printing while preserving image visibility.
     * Uses Gamma Correction.
     */
    private applyPrintBW(data: Uint8ClampedArray) {
        const gamma = 1.4; // Gamma value > 1 darkens midtones/shadows
        const gammaCorrection = 1 / gamma;

        // Pre-calculate look-up table for performance
        const lut = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            lut[i] = 255 * Math.pow(i / 255, gamma); // Actually we want to darken, so we raise to power gamma directly if input is normalized 0-1.
            // Wait, standard Gamma correction is usually Out = In^(1/gamma) to brighten.
            // To DARKEN, we want Out < In for In < 1. 
            // If In=0.5, Out=0.5^1.4 ≈ 0.37 (darker). 
            // So we use power of gamma, no inversion needed if gamma > 1.
        }

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // 1. Convert to grayscale using luminance (more accurate than average)
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;

            // 2. Apply darkness lookup
            const enhanced = lut[Math.floor(gray)];

            data[i] = data[i + 1] = data[i + 2] = enhanced;
        }
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
            const viewport = page.getViewport({ scale: 2.5 }); // Increased from 1.5

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d')!;
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({
                canvasContext: context,
                viewport: viewport,
                canvas: canvas
            }).promise;

            const imageDataUrl = canvas.toDataURL('image/jpeg', 0.95); // Increased from 0.8
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
            if (imageData.startsWith('data:application/pdf')) {
                console.warn('Skipping PDF attempt to embed in PDF via image embedding. Use merge instead.');
                continue;
            }
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
