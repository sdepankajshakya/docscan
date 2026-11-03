import { Injectable, inject } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource, Photo, GalleryPhotos, GalleryPhoto } from '@capacitor/camera';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { EdgeDetectionService } from './edge-detection.service';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { BoundedMemoryCache } from './bounded-cache';
import { DeviceCapabilityService } from './device-capability.service';

// Configure PDF.js worker - use local file instead of CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/pdf.worker.min.js';

export interface NativeStorageExportPluginInterface {
    exportWithSAF(options: {
        fileName: string;
        base64Data: string;
        mimeType?: string;
    }): Promise<{ success: boolean; cancelled?: boolean; uri?: string; message?: string }>;

    exportToMediaStore(options: {
        fileName: string;
        base64Data: string;
        mimeType?: string;
        directory?: 'DOCUMENTS' | 'DOWNLOADS';
    }): Promise<{ success: boolean; path?: string; uri?: string; message?: string }>;
}

export const NativeStorageExport = registerPlugin<NativeStorageExportPluginInterface>('NativeStorageExport');

/**
 * Reusable helper to release canvas backing store GPU memory immediately.
 */
export function releaseCanvas(canvas: HTMLCanvasElement | null | undefined): void {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}

export interface PDFExportOptions {
    totalPages?: number;
    onProgress?: (progress: { page: number; total: number; percentage: number }) => void;
    abortSignal?: AbortSignal;
}

export interface PDFExtractionOptions {
    scale?: number;
    quality?: number;
    saveToTempFiles?: boolean;
    virtualize?: boolean; // When true and pages > 10, enables instant virtual PDF session
    onProgress?: (pageNum: number, totalPages: number) => void;
    abortSignal?: AbortSignal;
}

/**
 * Service to handle document capture and image processing.
 * Responsible for interfacing with the Camera plugin and performing
 * canvas-based manipulations like grayscale and thresholding.
 * Also handles PDF processing and generation.
 * Includes OpenCV.js-based edge detection for document scanning.
 */

export type FilterType = 'original' | 'grayscale' | 'adaptive-threshold' | 'high-contrast' | 'invert' | 'sepia' | 'brightness' | 'vibrant' | 'print-bw';

export interface ScannedDocument {
    name: string;
    date: string;
    thumbnail: string | null;
    displayThumbnail?: string; // RUNTIME ONLY: Base64/Blob URL for UI
    fullImage?: string;
    type?: 'image' | 'pdf';
    pageCount?: number;        // Preserves multi-page relationships (Req 5)
    pageRefs?: string[];       // Virtual or relative page references
}

export interface DocumentCatalogPayload {
    version: number;
    lastSaved: number;
    documents: ScannedDocument[];
}

export type CatalogLoadStatus =
    | 'clean_install'
    | 'loaded_ok'
    | 'recovered_from_tmp'
    | 'recovered_from_bak'
    | 'recovered_orphans'
    | 'transient_error';

export interface MigrationState {
    inProgress: boolean;
    fromVersion: number;
    toVersion: number;
    startedAt: number;
    migratedThumbnails?: Array<{ original: string; migrated: string }>;
}

export interface ActiveDocumentState {
    image: string; // Data URL for single image
    images?: string[]; // Data URLs for multiple pages
    originalName?: string;
    originalDoc?: ScannedDocument;
    pageFilters?: FilterType[];
    currentPage?: number;
}

export interface EdgeDetectionState {
    imageData: string;
    detectedCorners?: Array<{ x: number; y: number }>;
    originalName?: string;
    sessionPages?: string[]; // Accumulated pages in current multi-page scanning session
    pageIndex?: number;      // Specific page index being cropped/re-adjusted from editor
    returnToEditor?: boolean; // Return to editor after crop
    isMultiScan?: boolean;   // Whether this is part of a multi-page camera session
}

export interface ProcessingState {
    fileName: string;
    progress: number; // 0-100
    totalPages?: number;
    processedPages?: number;
    timestamp: number;
    data?: any;
}

@Injectable({
    providedIn: 'root'
})
export class DocumentProcessingService {

    // File size limits (50MB)
    private readonly MAX_FILE_SIZE = 50 * 1024 * 1024;
    // PDF page limits
    private readonly MAX_PDF_PAGES = 100;

    private edgeDetectionService = inject(EdgeDetectionService);
    public deviceCapabilityService = inject(DeviceCapabilityService);

    // State management
    private _documents: ScannedDocument[] = [];
    private _isCatalogLoaded = false;
    private _catalogLoadStatus: CatalogLoadStatus = 'clean_install';
    private _processingState: ProcessingState | null = null;
    private _activeDocument: ActiveDocumentState | null = null;
    private _edgeDetectionState: EdgeDetectionState | null = null;

    get isCatalogLoaded(): boolean {
        return this._isCatalogLoaded;
    }

    get catalogLoadStatus(): CatalogLoadStatus {
        return this._catalogLoadStatus;
    }

    // Bounded memory cache for loaded page images (avoids keeping all full-res pages in RAM)
    private pageImageCache = new BoundedMemoryCache<string, string>({ maxEntries: 4 });
    // Track temporary session files created for large multi-page scans / PDF extractions
    private tempSessionFiles = new Set<string>();

    // Active PDF session for virtualized, on-demand PDF page rendering (handles 1,000+ page PDFs)
    private activePdfSession: {
        pdf: pdfjsLib.PDFDocumentProxy;
        totalPages: number;
        base64Data?: string;
    } | null = null;

    // Native Storage Export abstraction for Android SAF and MediaStore
    public nativeStorage = {
        exportWithSAF: (options: any) => NativeStorageExport.exportWithSAF(options),
        exportToMediaStore: (options: any) => NativeStorageExport.exportToMediaStore(options)
    };

    // Filesystem abstraction enabling atomic verification and deterministic test isolation
    public fs = {
        readFile: (options: any) => Filesystem.readFile(options),
        writeFile: (options: any) => Filesystem.writeFile(options),
        deleteFile: (options: any) => Filesystem.deleteFile(options),
        stat: (options: any) => Filesystem.stat(options),
        rename: (options: any) => Filesystem.rename(options),
        readdir: (options: any) => Filesystem.readdir(options),
        getUri: (options: any) => Filesystem.getUri(options),
        checkPermissions: () => Filesystem.checkPermissions(),
        requestPermissions: () => Filesystem.requestPermissions()
    };

    constructor() {
        this.adaptCacheLimits();
        this.loadProcessingState();
        this.cleanupOrphanedTempFiles();
    }

    /**
     * Dynamically adjusts bounded cache size based on real-time device memory capabilities
     */
    public adaptCacheLimits(): void {
        const config = this.deviceCapabilityService.getAdaptiveConfig();
        this.pageImageCache.setMaxEntries(config.maxCacheEntries);
    }

    /**
     * Opens an active PDF.js session for virtual on-demand page and thumbnail rendering
     */
    async openPdfSession(base64Data: string): Promise<{ totalPages: number }> {
        await this.closePdfSession();
        const binaryString = atob(base64Data.split(',')[1] || base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const pdf = await pdfjsLib.getDocument({ data: bytes.buffer }).promise;
        this.activePdfSession = {
            pdf,
            totalPages: pdf.numPages,
            base64Data
        };
        return { totalPages: pdf.numPages };
    }

    /**
     * Closes the active PDF session and frees all PDF.js memory
     */
    async closePdfSession(): Promise<void> {
        if (this.activePdfSession) {
            try {
                await this.activePdfSession.pdf.cleanup();
                await this.activePdfSession.pdf.destroy();
            } catch (e) {
                console.warn('PDF session cleanup error:', e);
            }
            this.activePdfSession = null;
        }
    }

    /**
     * Renders a specific page from the active PDF session on demand
     */
    async renderPdfSessionPage(pageNum: number, scale?: number, quality: number = 0.95): Promise<string> {
        if (!this.activePdfSession || pageNum < 1 || pageNum > this.activePdfSession.totalPages) {
            return '';
        }
        const config = this.deviceCapabilityService.getAdaptiveConfig();
        const targetScale = scale ?? config.exportScale;

        const page = await this.activePdfSession.pdf.getPage(pageNum);
        try {
            let viewport = page.getViewport({ scale: targetScale });
            const maxDim = 2500;
            if (viewport.width > maxDim || viewport.height > maxDim) {
                const adjustedScale = Math.min(maxDim / (viewport.width / targetScale), maxDim / (viewport.height / targetScale));
                viewport = page.getViewport({ scale: adjustedScale });
            }

            const canvas = document.createElement('canvas');
            try {
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const context = canvas.getContext('2d')!;
                await page.render({ canvasContext: context, viewport, canvas }).promise;
                return canvas.toDataURL('image/jpeg', quality);
            } finally {
                releaseCanvas(canvas);
            }
        } finally {
            page.cleanup();
        }
    }

    /**
     * Renders a lightweight thumbnail for a specific page from the active PDF session
     */
    async renderPdfSessionThumbnail(pageNum: number, maxWidth?: number, quality?: number): Promise<string> {
        if (!this.activePdfSession || pageNum < 1 || pageNum > this.activePdfSession.totalPages) {
            return '';
        }
        const config = this.deviceCapabilityService.getAdaptiveConfig();
        const targetWidth = maxWidth ?? config.thumbnailResolution;
        const targetQuality = quality ?? config.thumbnailQuality;

        const page = await this.activePdfSession.pdf.getPage(pageNum);
        try {
            const unscaledViewport = page.getViewport({ scale: 1.0 });
            const scale = Math.min(1.0, targetWidth / unscaledViewport.width);
            const viewport = page.getViewport({ scale });

            const canvas = document.createElement('canvas');
            try {
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const context = canvas.getContext('2d')!;
                await page.render({ canvasContext: context, viewport, canvas }).promise;
                return canvas.toDataURL('image/jpeg', targetQuality);
            } finally {
                releaseCanvas(canvas);
            }
        } finally {
            page.cleanup();
        }
    }

    /**
     * Register a temporary file created during current scanning/editing session
     */
    registerTempFile(filePath: string): void {
        this.tempSessionFiles.add(filePath);
    }

    /**
     * Clean up all temporary files created during the current session
     */
    async cleanupTempFiles(): Promise<void> {
        for (const file of this.tempSessionFiles) {
            try {
                await this.fs.deleteFile({ path: file, directory: Directory.Cache });
            } catch (e) { }
        }
        this.tempSessionFiles.clear();
        this.pageImageCache.clear();
        await this.closePdfSession();
    }

    /**
     * Cleans up any orphaned temp_page_* files in Directory.Cache from previous sessions
     */
    async cleanupOrphanedTempFiles(): Promise<void> {
        try {
            const result = await this.fs.readdir({
                path: '.',
                directory: Directory.Cache
            });
            if (result && result.files) {
                for (const file of result.files) {
                    const name = typeof file === 'string' ? file : file.name;
                    if (name && (name.startsWith('temp_page_') || name.startsWith('thumb_temp_'))) {
                        try {
                            await this.fs.deleteFile({ path: name, directory: Directory.Cache });
                        } catch (e) { }
                    }
                }
            }
        } catch (e) { }
    }

    // File Validation Methods
    /**
     * Validate file size before processing
     * @returns { valid: boolean, error?: string }
     */
    validateFileSize(fileSizeInBytes: number): { valid: boolean; error?: string } {
        if (fileSizeInBytes > this.MAX_FILE_SIZE) {
            const maxSizeMB = this.MAX_FILE_SIZE / (1024 * 1024);
            return {
                valid: false,
                error: `File too large. Maximum size: ${maxSizeMB}MB`
            };
        }
        return { valid: true };
    }

    /**
     * Validate PDF page count
     * @returns { valid: boolean, warning?: string }
     */
    validatePdfPages(pageCount: number): { valid: boolean; warning?: string } {
        if (pageCount > this.MAX_PDF_PAGES) {
            return {
                valid: true,
                warning: `Large PDF detected (${pageCount} pages). This may take longer to process. Processing will continue in background.`
            };
        }
        return { valid: true };
    }

    // Processing State Management
    /**
     * Save processing state to persistent storage
     */
    async saveProcessingState(state: ProcessingState): Promise<void> {
        try {
            this._processingState = state;
            await this.fs.writeFile({
                path: 'processing_state.json',
                data: JSON.stringify(state),
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });
        } catch (e) {
            console.error('Failed to save processing state:', e);
        }
    }

    /**
     * Load processing state from storage
     */
    private async loadProcessingState(): Promise<void> {
        try {
            const file = await this.fs.readFile({
                path: 'processing_state.json',
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });
            this._processingState = JSON.parse(file.data as string);
            console.log('Processing state loaded:', this._processingState?.fileName);
        } catch (e) {
            // No saved state - this is normal on first run
            this._processingState = null;
        }
    }

    /**
     * Get current processing state
     */
    async getProcessingState(): Promise<ProcessingState | null> {
        return this._processingState;
    }

    /**
     * Clear processing state (call when processing completes)
     */
    async clearProcessingState(): Promise<void> {
        try {
            this._processingState = null;
            await this.fs.deleteFile({
                path: 'processing_state.json',
                directory: Directory.Data
            });
            console.log('Processing state cleared');
        } catch (e) {
            // File might not exist - that's okay
        }
    }

    /**
     * Update processing progress
     */
    async updateProcessingProgress(progress: number, processedPages?: number): Promise<void> {
        if (this._processingState) {
            this._processingState.progress = progress;
            if (processedPages !== undefined) {
                this._processingState.processedPages = processedPages;
            }
            this._processingState.timestamp = Date.now();
            await this.saveProcessingState(this._processingState);
        }
    }

    // Document State Methods
    get documents(): ScannedDocument[] {
        return this._documents;
    }

    /**
     * Parses catalog raw string supporting both legacy array format and versioned container.
     */
    private parseCatalogData(raw: string): ScannedDocument[] | null {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed;
            } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.documents)) {
                return parsed.documents;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Resumes any migration that was interrupted by app termination (Req 7).
     */
    private async checkAndResumeInterruptedMigration(): Promise<void> {
        try {
            const stateFile = await this.fs.readFile({
                path: 'migration_state.json',
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });
            if (stateFile && stateFile.data) {
                const state: MigrationState = JSON.parse(stateFile.data as string);
                if (state && state.inProgress) {
                    console.log('Detected interrupted migration from version', state.fromVersion, 'to', state.toVersion);
                    if (state.migratedThumbnails) {
                        for (const item of state.migratedThumbnails) {
                            try {
                                const stat = await this.fs.stat({ path: item.migrated, directory: Directory.Data });
                                if (!stat || stat.size === 0) {
                                    console.warn('Incomplete migrated thumbnail detected:', item.migrated);
                                }
                            } catch {}
                        }
                    }
                }
            }
        } catch {
            // No migration lock file present (normal state)
        }
    }

    /**
     * Executes safe, verified migrations using copy-verify-preserve (Req 7, 8).
     */
    private async executeSafeMigrations(): Promise<void> {
        const needingMigration = this._documents.filter(d => d.thumbnail && d.thumbnail.startsWith('data:'));
        if (needingMigration.length === 0) {
            try {
                await this.fs.deleteFile({ path: 'migration_state.json', directory: Directory.Data });
            } catch {}
            return;
        }

        const migrationState: MigrationState = {
            inProgress: true,
            fromVersion: 1,
            toVersion: 2,
            startedAt: Date.now(),
            migratedThumbnails: []
        };

        try {
            await this.fs.writeFile({
                path: 'migration_state.json',
                data: JSON.stringify(migrationState),
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });

            for (const doc of needingMigration) {
                if (doc.thumbnail && doc.thumbnail.startsWith('data:')) {
                    const originalThumb = doc.thumbnail;
                    const fileName = await this.saveThumbnailToFile(originalThumb);

                    // Verify file exists on disk with size > 0 (Req 8)
                    const stat = await this.fs.stat({ path: fileName, directory: Directory.Data });
                    if (!stat || stat.size === 0) {
                        throw new Error(`Migration verification failed for thumbnail ${fileName}`);
                    }

                    // Update reference only after verification passes
                    doc.thumbnail = fileName;
                    migrationState.migratedThumbnails?.push({
                        original: originalThumb.substring(0, 50) + '...',
                        migrated: fileName
                    });

                    // Update migration state checkpoint
                    await this.fs.writeFile({
                        path: 'migration_state.json',
                        data: JSON.stringify(migrationState),
                        directory: Directory.Data,
                        encoding: Encoding.UTF8
                    });
                }
            }

            // Commit atomic save of updated catalog
            await this.saveDocumentsList();

            // Only delete migration lock after catalog is safely verified and committed
            await this.fs.deleteFile({
                path: 'migration_state.json',
                directory: Directory.Data
            });
            console.log(`Successfully migrated ${needingMigration.length} document thumbnails to disk!`);
        } catch (migErr) {
            console.error('Migration halted or interrupted. Originals preserved:', migErr);
        }
    }

    /**
     * Memory-conscious PDF page count determination (Req 4).
     * Avoids loading/decoding entire multi-megabyte PDFs into string memory.
     * Uses PDF.js URL streaming or binary xref parsing via PDFDocument.load.
     */
    public async getPdfPageCount(fileName: string): Promise<number> {
        // 1. Try memory-conscious URL streaming via PDF.js (reads only trailer/page table)
        try {
            const uriResult = await this.fs.getUri({ path: fileName, directory: Directory.Data });
            if (uriResult && uriResult.uri) {
                const fileSrc = Capacitor.isNativePlatform() ? Capacitor.convertFileSrc(uriResult.uri) : uriResult.uri;
                const loadingTask = pdfjsLib.getDocument({
                    url: fileSrc,
                    disableAutoFetch: true,
                    disableStream: false
                });
                const pdf = await loadingTask.promise;
                const pages = pdf.numPages;
                await pdf.cleanup();
                await pdf.destroy();
                if (pages > 0) return pages;
            }
        } catch {}

        // 2. Binary xref parsing via PDFDocument.load (handles compressed /ObjStm streams)
        try {
            const fileContent = await this.fs.readFile({
                path: fileName,
                directory: Directory.Data
            });
            if (fileContent && fileContent.data) {
                const raw = fileContent.data as string;
                const base64 = raw.includes(',') ? raw.substring(raw.indexOf(',') + 1) : raw;
                const binary = atob(base64);
                const len = binary.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
                const count = pdfDoc.getPageCount();
                if (count > 0) return count;
            }
        } catch {
            // 3. Fallback for mock/test strings or non-standard PDFs
            try {
                const fileContent = await this.fs.readFile({
                    path: fileName,
                    directory: Directory.Data
                });
                if (fileContent && fileContent.data) {
                    const raw = fileContent.data as string;
                    const base64 = raw.includes(',') ? raw.substring(raw.indexOf(',') + 1) : raw;
                    const binary = atob(base64);
                    const matches = binary.match(/\/Type\s*\/Page[^s]/g);
                    if (matches && matches.length > 0) {
                        return matches.length;
                    }
                }
            } catch {}
        }

        return 1;
    }

    /**
     * Computes a fast, lightweight signature for a file to detect duplicates without reading whole contents.
     */
    public async computeFileSignature(fileName: string): Promise<string | null> {
        try {
            const stat = await this.fs.stat({ path: fileName, directory: Directory.Data });
            if (!stat || typeof stat.size !== 'number') return null;
            const ext = (fileName.split('.').pop() || '').toLowerCase();
            return `${ext}_${stat.size}`;
        } catch {
            return null;
        }
    }

    /**
     * Conservative Orphan Recovery (Req 4, 5).
     * Discovers unreferenced doc_* files in Directory.Data, preserves multi-page relationships,
     * avoids duplicate recovery, and NEVER automatically deletes any unknown files.
     */
    public async recoverOrphanDocuments(): Promise<ScannedDocument[]> {
        const recovered: ScannedDocument[] = [];
        try {
            const dir = await this.fs.readdir({
                path: '.',
                directory: Directory.Data
            });
            if (!dir || !dir.files) return recovered;

            const knownFiles = new Set<string>();
            const knownSignatures = new Set<string>();

            for (const doc of this._documents) {
                if (doc.fullImage) {
                    knownFiles.add(doc.fullImage);
                    const sig = await this.computeFileSignature(doc.fullImage);
                    if (sig) knownSignatures.add(sig);
                }
                if (doc.thumbnail) knownFiles.add(doc.thumbnail);
            }

            for (const fileItem of dir.files) {
                const fileName = typeof fileItem === 'string' ? fileItem : fileItem.name;
                if (!fileName) continue;

                // Only inspect unreferenced document files starting with doc_
                if (fileName.startsWith('doc_') && !knownFiles.has(fileName)) {
                    const ext = fileName.split('.').pop()?.toLowerCase();
                    if (ext !== 'pdf' && ext !== 'jpg' && ext !== 'jpeg' && ext !== 'png') {
                        // Conservative rule: do not touch or delete unknown files (Req 4)
                        continue;
                    }

                    // Check for duplicate orphan file without deleting original file
                    const fileSig = await this.computeFileSignature(fileName);
                    if (fileSig && knownSignatures.has(fileSig)) {
                        console.log('Skipping duplicate orphan document file without deleting:', fileName);
                        continue;
                    }
                    if (fileSig) {
                        knownSignatures.add(fileSig);
                    }

                    // Extract timestamp if encoded in doc_<timestamp>_<random>.<ext>
                    const parts = fileName.split('_');
                    const ts = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
                    const dateStr = !isNaN(ts) && ts > 0 ? new Date(ts).toLocaleString() : new Date().toLocaleString();
                    const isPdf = ext === 'pdf';

                    let pageCount = 1;
                    if (isPdf) {
                        pageCount = await this.getPdfPageCount(fileName);
                    }

                    const docEntry: ScannedDocument = {
                        name: `Recovered_${fileName.replace(/\.[^/.]+$/, "")}`,
                        date: dateStr,
                        thumbnail: null,
                        fullImage: fileName,
                        type: isPdf ? 'pdf' : 'image',
                        pageCount
                    };

                    // Generate thumbnail for the recovered document
                    try {
                        let thumbData: string | null = null;
                        if (isPdf) {
                            const directMock = await this.createThumbnail(fileName, 170, 0.65).catch(() => null);
                            if (directMock && directMock.startsWith('data:image/')) {
                                thumbData = directMock;
                            } else {
                                const uriResult = await this.fs.getUri({ path: fileName, directory: Directory.Data }).catch(() => null);
                                let pdf: pdfjsLib.PDFDocumentProxy | null = null;
                                if (uriResult?.uri) {
                                    const src = Capacitor.isNativePlatform() ? Capacitor.convertFileSrc(uriResult.uri) : uriResult.uri;
                                    pdf = await pdfjsLib.getDocument({ url: src, disableAutoFetch: true }).promise.catch(() => null);
                                }
                                if (!pdf) {
                                    const fileContent = await this.fs.readFile({ path: fileName, directory: Directory.Data });
                                    const raw = (fileContent.data as string) || '';
                                    const base64 = raw.includes(',') ? raw.substring(raw.indexOf(',') + 1) : raw;
                                    const bin = atob(base64);
                                    const bytes = new Uint8Array(bin.length);
                                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                                    pdf = await pdfjsLib.getDocument({ data: bytes.buffer }).promise.catch(() => null);
                                }
                                if (pdf) {
                                    const page = await pdf.getPage(1);
                                    const viewport = page.getViewport({ scale: 1 });
                                    const scale = 170 / (viewport.width || 1);
                                    const scaledViewport = page.getViewport({ scale });
                                    const canvas = document.createElement('canvas');
                                    canvas.width = Math.max(1, Math.round(scaledViewport.width));
                                    canvas.height = Math.max(1, Math.round(scaledViewport.height));
                                    const ctx = canvas.getContext('2d')!;
                                    await page.render({ canvasContext: ctx, viewport: scaledViewport, canvas }).promise;
                                    thumbData = canvas.toDataURL('image/jpeg', 0.65);
                                    releaseCanvas(canvas);
                                    await pdf.cleanup();
                                    await pdf.destroy();
                                }
                            }
                        } else {
                            thumbData = await this.createThumbnail(fileName, 170, 0.65);
                        }

                        if (thumbData) {
                            const thumbFileName = `thumb_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
                            await this.fs.writeFile({
                                path: thumbFileName,
                                data: thumbData,
                                directory: Directory.Data
                            });
                            docEntry.thumbnail = thumbFileName;
                            docEntry.displayThumbnail = thumbData;
                        }
                    } catch (thumbErr) {
                        console.warn('Could not generate thumbnail for recovered document:', fileName, thumbErr);
                    }

                    recovered.push(docEntry);
                }
            }
        } catch (e) {
            console.warn('Error during orphan recovery scan:', e);
        }
        return recovered;
    }

    /**
     * Resilient Document Loading with 4-Tier Fallback (Req 1, 3).
     * Distinguishes clean install, missing metadata, corrupted metadata, and transient errors.
     * Checks primary documents.json -> staging documents.json.tmp -> backup documents.json.bak -> orphan recovery.
     * NEVER resets to empty array on transient error or unparseable metadata.
     */
    async loadDocuments(): Promise<void> {
        await this.checkAndResumeInterruptedMigration();

        let loadedDocs: ScannedDocument[] | null = null;
        let recoverySource: 'none' | 'tmp' | 'bak' | 'orphans' = 'none';

        // Step 1: Attempt to read primary documents.json
        try {
            const readFile = await this.fs.readFile({
                path: 'documents.json',
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });

            if (readFile && readFile.data) {
                loadedDocs = this.parseCatalogData(readFile.data as string);
                if (loadedDocs !== null) {
                    this._catalogLoadStatus = 'loaded_ok';
                    // Clean up any lingering temporary file if present
                    try {
                        await this.fs.deleteFile({ path: 'documents.json.tmp', directory: Directory.Data });
                    } catch {}
                } else {
                    throw new SyntaxError('Invalid JSON structure in documents.json');
                }
            }
        } catch (primaryErr: any) {
            const msg = (primaryErr?.message || '').toLowerCase();
            const isFileNotFound = msg.includes('does not exist') || msg.includes('no such file') || msg.includes('not found') || msg.includes('enoent');
            const isCorrupt = primaryErr instanceof SyntaxError || msg.includes('syntax') || msg.includes('unexpected token') || msg.includes('json');

            if (isCorrupt) {
                console.warn('Primary documents.json corrupted:', primaryErr);
                // Preserve corrupted file for forensic recovery (Req 8)
                try {
                    const rawBad = await this.fs.readFile({
                        path: 'documents.json',
                        directory: Directory.Data,
                        encoding: Encoding.UTF8
                    });
                    await this.fs.writeFile({
                        path: `documents_corrupted_${Date.now()}.json`,
                        data: rawBad.data,
                        directory: Directory.Data,
                        encoding: Encoding.UTF8
                    });
                } catch {}
            } else if (!isFileNotFound) {
                // Transient I/O or permissions error (Req 3)
                console.error('Transient filesystem error reading documents.json:', primaryErr);
                this._catalogLoadStatus = 'transient_error';
                // If we already have documents in memory, DO NOT reset to empty array! (Req 1)
                if (this._isCatalogLoaded && this._documents.length > 0) {
                    return;
                }
            }
        }

        // Step 2: If primary failed or was corrupt, attempt to recover from documents.json.tmp
        if (!loadedDocs) {
            try {
                const tmpFile = await this.fs.readFile({
                    path: 'documents.json.tmp',
                    directory: Directory.Data,
                    encoding: Encoding.UTF8
                });
                if (tmpFile && tmpFile.data) {
                    const tmpDocs = this.parseCatalogData(tmpFile.data as string);
                    if (tmpDocs !== null) {
                        loadedDocs = tmpDocs;
                        recoverySource = 'tmp';
                        this._catalogLoadStatus = 'recovered_from_tmp';
                        console.log('Successfully recovered document catalog from documents.json.tmp!');
                    }
                }
            } catch {
                // Temp file not present or unreadable
            }
        }

        // Step 3: If still not loaded, attempt to recover from documents.json.bak
        if (!loadedDocs) {
            try {
                const bakFile = await this.fs.readFile({
                    path: 'documents.json.bak',
                    directory: Directory.Data,
                    encoding: Encoding.UTF8
                });
                if (bakFile && bakFile.data) {
                    const bakDocs = this.parseCatalogData(bakFile.data as string);
                    if (bakDocs !== null) {
                        loadedDocs = bakDocs;
                        recoverySource = 'bak';
                        this._catalogLoadStatus = 'recovered_from_bak';
                        console.log('Successfully recovered document catalog from backup!');
                    }
                }
            } catch {
                // Backup not present or unreadable
            }
        }

        // Step 4: If still not loaded, distinguish clean install vs lost metadata with orphan recovery (Req 3, 4)
        if (!loadedDocs) {
            const orphanDocs = await this.recoverOrphanDocuments();
            if (orphanDocs.length > 0) {
                loadedDocs = orphanDocs;
                recoverySource = 'orphans';
                this._catalogLoadStatus = 'recovered_orphans';
                console.log(`Recovered ${orphanDocs.length} orphan documents from disk.`);
            } else {
                // Truly clean install: no primary, no tmp, no backup, no doc_* files on disk
                loadedDocs = [];
                this._catalogLoadStatus = 'clean_install';
            }
        }

        // Safe catalog assignment (NEVER reset to [] after read or parsing failure)
        this._documents = loadedDocs;
        this._isCatalogLoaded = true;

        // If recovered from tmp, backup, or orphans, commit save to recreate primary documents.json
        if (recoverySource !== 'none') {
            try {
                await this.saveDocumentsList();
            } catch (saveErr) {
                console.error('Failed to commit recovered catalog:', saveErr);
            }
        }

        // Step 5: Execute restartable migrations (Req 7, 8)
        await this.executeSafeMigrations();
    }

    async addDocument(doc: ScannedDocument) {
        let createdImageFile: string | null = null;
        let createdThumbFile: string | null = null;

        try {
            // If fullImage is Base64, save to filesystem
            if (doc.fullImage && doc.fullImage.startsWith('data:')) {
                const timestamp = new Date().getTime();
                const ext = doc.type === 'pdf' ? 'pdf' : 'jpg';
                const fileName = `doc_${timestamp}_${Math.floor(Math.random() * 1000)}.${ext}`;

                await this.fs.writeFile({
                    path: fileName,
                    data: doc.fullImage,
                    directory: Directory.Data
                });
                createdImageFile = fileName;
                doc.fullImage = fileName;
            }

            // If thumbnail is Base64, save to filesystem
            if (doc.thumbnail && doc.thumbnail.startsWith('data:')) {
                const thumbFile = await this.saveThumbnailToFile(doc.thumbnail);
                createdThumbFile = thumbFile;
                doc.thumbnail = thumbFile;
            }

            // Pre-load displayThumbnail so it appears immediately in the UI
            doc.displayThumbnail = await this.resolveThumbnailUrl(doc);

            this._documents.unshift(doc);
            await this.saveDocumentsList();
        } catch (e: any) {
            // Roll back if catalog save failed
            const idx = this._documents.indexOf(doc);
            if (idx > -1) {
                this._documents.splice(idx, 1);
            }
            if (createdImageFile) {
                try {
                    await this.fs.deleteFile({ path: createdImageFile, directory: Directory.Data });
                } catch {}
            }
            if (createdThumbFile) {
                try {
                    await this.fs.deleteFile({ path: createdThumbFile, directory: Directory.Data });
                } catch {}
            }
            console.error('Failed to add document:', e);
            const msg = (e?.message || '').toLowerCase();
            if (msg.includes('quota') || msg.includes('storage') || msg.includes('space') || msg.includes('enospc')) {
                throw new Error('Device storage is full. Please free up space and try again.');
            }
            throw e;
        }
    }

    async updateDocument(originalDoc: ScannedDocument, newImageBase64: string, newThumbnail: string, newType?: 'image' | 'pdf') {
        const oldFile = originalDoc.fullImage;
        const oldThumb = originalDoc.thumbnail;
        const timestamp = new Date().getTime();
        if (newType) {
            originalDoc.type = newType;
            if (newType === 'pdf' && originalDoc.name.endsWith('.jpg')) {
                originalDoc.name = originalDoc.name.replace(/\.jpg$/i, '.pdf');
            }
        }
        const ext = originalDoc.type === 'pdf' ? 'pdf' : 'jpg';
        const fileName = `doc_${timestamp}_${Math.floor(Math.random() * 1000)}.${ext}`;

        try {
            // 1. Save new high-res file
            await this.fs.writeFile({
                path: fileName,
                data: newImageBase64,
                directory: Directory.Data
            });

            // 2. Save new thumbnail file
            const thumbFileName = await this.saveThumbnailToFile(newThumbnail);

            // 3. VERIFY new files exist before touching metadata or old files (Req 8)
            const imgStat = await this.fs.stat({ path: fileName, directory: Directory.Data });
            const thumbStat = await this.fs.stat({ path: thumbFileName, directory: Directory.Data });
            if (!imgStat || imgStat.size === 0 || !thumbStat || thumbStat.size === 0) {
                throw new Error('Verification failed: newly written document files are missing or empty.');
            }

            // 4. Update references in document object
            originalDoc.fullImage = fileName;
            originalDoc.thumbnail = thumbFileName;

            // Invalidate cache for replaced files
            if (oldFile) {
                this.pageImageCache.delete(oldFile);
            }
            if (oldThumb) {
                this.pageImageCache.delete(oldThumb);
            }

            // Update displayThumbnail so the new thumbnail appears immediately
            originalDoc.displayThumbnail = await this.resolveThumbnailUrl(originalDoc);

            // 5. Commit atomic save to catalog
            await this.saveDocumentsList();
            await this.cleanupTempFiles();

            // 6. ONLY AFTER successful verified save, delete old files (Req 8)
            if (oldFile && !oldFile.startsWith('data:') && oldFile !== fileName) {
                try {
                    await this.fs.deleteFile({ path: oldFile, directory: Directory.Data });
                } catch (e) { }
            }
            if (oldThumb && !oldThumb.startsWith('data:') && oldThumb !== thumbFileName) {
                try {
                    await this.fs.deleteFile({ path: oldThumb, directory: Directory.Data });
                } catch (e) { }
            }

        } catch (e: any) {
            console.error('Failed to update document files', e);
            const msg = (e?.message || '').toLowerCase();
            if (msg.includes('quota') || msg.includes('storage') || msg.includes('space') || msg.includes('enospc')) {
                throw new Error('Device storage is full. Please free up space and try again.');
            }
            throw e;
        }
    }

    async deleteDocument(doc: ScannedDocument) {
        if (doc.fullImage) {
            this.pageImageCache.delete(doc.fullImage);
        }
        if (doc.thumbnail) {
            this.pageImageCache.delete(doc.thumbnail);
        }

        const index = this._documents.findIndex(d => d.name === doc.name && d.date === doc.date);
        if (index > -1) {
            const [removed] = this._documents.splice(index, 1);
            try {
                await this.saveDocumentsList();
            } catch (saveErr) {
                // If saving catalog failed, roll back removal!
                this._documents.splice(index, 0, removed);
                throw saveErr;
            }
        }

        // Only after metadata is successfully saved, delete physical files
        if (doc.fullImage && !doc.fullImage.startsWith('data:')) {
            try {
                await this.fs.deleteFile({ path: doc.fullImage, directory: Directory.Data });
            } catch (e) { }
        }
        if (doc.thumbnail && !doc.thumbnail.startsWith('data:')) {
            try {
                await this.fs.deleteFile({ path: doc.thumbnail, directory: Directory.Data });
            } catch (e) { }
        }
    }

    async renameDocument(doc: ScannedDocument, newName: string) {
        // ONLY update the display name. DO NOT RENAME THE FILE.
        // This makes renaming instant and prevents file lock issues.
        doc.name = newName;
        await this.saveDocumentsList();
    }

    /**
     * Shared storage export using Storage Access Framework (SAF) / MediaStore / Download Manager (Req 6).
     * Does NOT rely on share sheet as a guaranteed destination.
     */
    async saveDocumentAs(
        doc: ScannedDocument,
        format: 'image' | 'pdf'
    ): Promise<{ success: boolean; message: string; path?: string }> {
        if (!doc.fullImage) {
            throw new Error('Document has no image data to export');
        }

        // Load image if not loaded - ensure it is a full Data URL
        let imageSrc = doc.fullImage;
        if (!doc.fullImage.startsWith('data:')) {
            const loaded = await this.loadDocumentImage(doc.fullImage);
            if (loaded) imageSrc = loaded;
            else throw new Error('Failed to load document content');
        }

        const baseName = doc.name.replace(/\.[^/.]+$/, "");
        const uniqueSuffix = `_${Date.now()}`;
        const fileName = format === 'image' ?
            `${baseName}_saved${uniqueSuffix}.jpg` :
            `${baseName}${uniqueSuffix}.pdf`;

        const isPdf = format === 'pdf' || doc.type === 'pdf' || imageSrc.startsWith('data:application/pdf');
        const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';
        const ext = isPdf ? 'pdf' : 'jpg';

        // Prepare binary blob and base64
        let blob: Blob;
        let dataToWrite = '';
        if (isPdf) {
            if (doc.type === 'pdf' || imageSrc.startsWith('data:application/pdf')) {
                blob = this.dataURLToBlob(imageSrc);
                dataToWrite = imageSrc;
            } else {
                blob = await this.exportAsPDF([imageSrc], baseName);
                dataToWrite = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            }
        } else {
            blob = this.dataURLToBlob(imageSrc);
            dataToWrite = imageSrc;
        }

        // 1. Android Native Export: Storage Access Framework (SAF) & MediaStore
        // Does not rely on window.showSaveFilePicker or browser download fallback on Android.
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
            try {
                // Tier 1 on Android: Storage Access Framework (ACTION_CREATE_DOCUMENT)
                const safResult = await this.nativeStorage.exportWithSAF({
                    fileName,
                    base64Data: dataToWrite,
                    mimeType
                });

                if (safResult && safResult.cancelled) {
                    return { success: false, message: 'Export cancelled by user' };
                }

                if (safResult && safResult.success) {
                    const msg = `File saved successfully via Document Picker as ${fileName}`;
                    alert(msg);
                    return {
                        success: true,
                        path: safResult.uri || fileName,
                        message: msg
                    };
                }
            } catch (safErr) {
                console.warn('Native SAF export failed, attempting MediaStore fallback:', safErr);
            }

            // Tier 2 on Android: MediaStore (Android 10+ / API 29+ zero permissions) or public folder fallback
            try {
                const mediaResult = await this.nativeStorage.exportToMediaStore({
                    fileName,
                    base64Data: dataToWrite,
                    mimeType,
                    directory: 'DOCUMENTS'
                });

                if (mediaResult && mediaResult.success) {
                    const msg = `File saved to Documents folder as ${fileName}`;
                    alert(msg);
                    return {
                        success: true,
                        path: mediaResult.path || mediaResult.uri || `Documents/${fileName}`,
                        message: msg
                    };
                }
            } catch (mediaErr: any) {
                console.error('Native MediaStore export failed:', mediaErr);
                throw new Error(`Android export failed: ${mediaErr?.message || mediaErr}`);
            }
        }

        // 2. Web / Desktop File System Access API (when supported on browser/desktop)
        if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
            try {
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName: fileName,
                    types: [{
                        description: isPdf ? 'PDF Document' : 'JPEG Image',
                        accept: { [mimeType]: [`.${ext}`] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                const msg = `File saved successfully via Document Picker as ${fileName}`;
                alert(msg);
                return { success: true, message: msg };
            } catch (safErr: any) {
                if (safErr?.name === 'AbortError') {
                    return { success: false, message: 'Export cancelled by user' };
                }
                console.warn('SAF showSaveFilePicker failed or unpermitted, falling back to storage write:', safErr);
            }
        }

        // 3. Web / Standard Browser Download Manager
        this.downloadBlob(blob, fileName);
        const webMsg = `File downloaded as ${fileName}`;
        return {
            success: true,
            path: `Downloads/${fileName}`,
            message: webMsg
        };
    }

    async saveProcessedDocument(
        images: string[],
        baseName: string,
        format: 'image' | 'pdf',
        thumbnail?: string,
        options?: PDFExportOptions
    ) {
        if (!images.length) return;

        // Ensure we have a valid name
        let name = baseName;
        // Strip extension if present
        name = name.replace(/\.(jpg|jpeg|png|pdf)$/i, '');

        try {
            if (format === 'pdf' || images.length > 1) {
                const pdfBlob = await this.exportAsPDF(images, name, options);
                const reader = new FileReader();

                await new Promise<void>((resolve, reject) => {
                    reader.onloadend = async () => {
                        try {
                            const base64data = reader.result as string;

                            await this.addDocument({
                                name: `${name}.pdf`,
                                date: new Date().toLocaleString(),
                                thumbnail: thumbnail || null,
                                fullImage: base64data,
                                type: 'pdf'
                            });
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(pdfBlob);
                });
            } else {
                // Save as Image (First page only)
                const firstImageData = await this.resolvePageDataUrl(images[0]);
                await this.addDocument({
                    name: `${name}.jpg`,
                    date: new Date().toLocaleString(),
                    thumbnail: thumbnail || null,
                    fullImage: firstImageData,
                    type: 'image'
                });
            }
            await this.cleanupTempFiles();
        } catch (e: any) {
            console.error('Failed to save processed document:', e);
            const msg = (e?.message || '').toLowerCase();
            if (msg.includes('quota') || msg.includes('storage') || msg.includes('space') || msg.includes('enospc')) {
                throw new Error('Device storage is full. Please free up space and try again.');
            }
            throw e;
        }
    }

    /**
     * Safe Catalog Updates (Req 1, Req 2).
     * Prevents data loss on Android where Capacitor Filesystem.rename is not atomic.
     * Always preserves verified backup (.bak) and temporary catalog (.tmp)
     * until the new catalog has been successfully written and verified on disk.
     */
    public async saveDocumentsList(): Promise<void> {
        if (!this._isCatalogLoaded) {
            throw new Error('Safety guard: cannot save document catalog because it has not been safely loaded.');
        }

        const payload: DocumentCatalogPayload = {
            version: 2,
            lastSaved: Date.now(),
            documents: this._documents
        };
        const jsonString = JSON.stringify(payload, null, 2);

        // 1. Write to temporary staging file
        const tempFile = 'documents.json.tmp';
        await this.fs.writeFile({
            path: tempFile,
            data: jsonString,
            directory: Directory.Data,
            encoding: Encoding.UTF8
        });

        // 2. Validate temp file: read back and verify JSON integrity and document count
        try {
            const verifyTemp = await this.fs.readFile({
                path: tempFile,
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });
            const verifiedDocs = this.parseCatalogData(verifyTemp.data as string);
            if (!verifiedDocs || verifiedDocs.length !== this._documents.length) {
                throw new Error('Validation mismatch in temp catalog file');
            }
        } catch (valErr) {
            try {
                await this.fs.deleteFile({ path: tempFile, directory: Directory.Data });
            } catch {}
            throw new Error(`Catalog write aborted: temp file validation failed: ${valErr}`);
        }

        // 3. Backup rotation: create verified copy of existing documents.json in documents.json.bak
        try {
            const currentPrimary = await this.fs.readFile({
                path: 'documents.json',
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });
            if (currentPrimary && currentPrimary.data) {
                await this.fs.writeFile({
                    path: 'documents.json.bak',
                    data: currentPrimary.data,
                    directory: Directory.Data,
                    encoding: Encoding.UTF8
                });
            }
        } catch {
            // No existing primary file yet (first save)
        }

        // 4. Safe write to primary catalog (preserves .tmp and .bak during write)
        await this.fs.writeFile({
            path: 'documents.json',
            data: jsonString,
            directory: Directory.Data,
            encoding: Encoding.UTF8
        });

        // 5. Verify primary catalog was successfully written and is uncorrupted
        try {
            const verifyPrimary = await this.fs.readFile({
                path: 'documents.json',
                directory: Directory.Data,
                encoding: Encoding.UTF8
            });
            const verifiedPrimaryDocs = this.parseCatalogData(verifyPrimary.data as string);
            if (!verifiedPrimaryDocs || verifiedPrimaryDocs.length !== this._documents.length) {
                throw new Error('Verification failed: primary catalog is invalid or incomplete after write');
            }
        } catch (verifyErr) {
            console.error('CRITICAL: Primary catalog verification failed after write:', verifyErr);
            throw new Error(`Catalog write verification failed: ${verifyErr}`);
        }

        // 6. Only remove temporary file AFTER primary is completely written and verified
        try {
            await this.fs.deleteFile({ path: tempFile, directory: Directory.Data });
        } catch {}
    }

    async loadDocumentImage(filePath: string): Promise<string | null> {
        if (!filePath) return null;
        if (filePath.startsWith('data:')) return filePath;

        // Check bounded cache first to avoid redundant disk I/O and base64 allocations
        const cached = this.pageImageCache.get(filePath);
        if (cached) return cached;

        try {
            let readFile;
            try {
                readFile = await this.fs.readFile({
                    path: filePath,
                    directory: Directory.Data
                });
            } catch (dataErr) {
                // If not in Data directory, check Cache directory
                readFile = await this.fs.readFile({
                    path: filePath,
                    directory: Directory.Cache
                });
            }

            // Determine mime type from extension
            const ext = filePath.split('.').pop()?.toLowerCase();
            const mimeType = ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
            const dataUrl = `data:${mimeType};base64,${readFile.data}`;

            this.pageImageCache.set(filePath, dataUrl);
            return dataUrl;
        } catch (e) {
            console.error('Error loading file', filePath, e);
            return null;
        }
    }

    /**
     * Resolves a file path, virtual PDF page ('pdf:N'), or data URL to a full data URL, utilizing the bounded memory cache.
     */
    async resolvePageDataUrl(pathOrDataUrl: string): Promise<string> {
        if (!pathOrDataUrl) return '';
        if (pathOrDataUrl.startsWith('data:')) return pathOrDataUrl;

        if (pathOrDataUrl.startsWith('pdf:')) {
            const cached = this.pageImageCache.get(pathOrDataUrl);
            if (cached) return cached;
            const pageNum = parseInt(pathOrDataUrl.split(':')[1], 10);
            const rendered = await this.renderPdfSessionPage(pageNum);
            if (rendered) {
                this.pageImageCache.set(pathOrDataUrl, rendered);
            }
            return rendered;
        }

        const loaded = await this.loadDocumentImage(pathOrDataUrl);
        return loaded || '';
    }

    /**
     * Internal helper to save a thumbnail to the filesystem and verify its write (Req 8).
     */
    public async saveThumbnailToFile(base64: string): Promise<string> {
        const timestamp = new Date().getTime();
        const fileName = `thumb_${timestamp}_${Math.floor(Math.random() * 1000)}.jpg`;

        await this.fs.writeFile({
            path: fileName,
            data: base64,
            directory: Directory.Data
        });

        // Verify thumbnail file write (Req 8)
        try {
            const stat = await this.fs.stat({ path: fileName, directory: Directory.Data });
            if (!stat || stat.size === 0) {
                throw new Error(`Failed to verify written thumbnail file: ${fileName}`);
            }
        } catch (statErr: any) {
            if (statErr?.message?.includes('verify')) {
                throw statErr;
            }
        }

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
                const uriResult = await this.fs.getUri({
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
     * Uses incremental rendering, bounded memory caching, and explicit cleanup.
     * For large PDFs, pages can be saved directly to temporary cache files to prevent JS heap exhaustion.
     */
    async extractPagesFromPDFData(
        base64Data: string,
        options?: PDFExtractionOptions
    ): Promise<string[]> {
        // Convert base64 to Uint8Array/ArrayBuffer
        const binaryString = atob(base64Data.split(',')[1] || base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const pdf = await pdfjsLib.getDocument({ data: bytes.buffer }).promise;
        const totalPages = pdf.numPages;

        // Virtualized PDF session: for documents > 10 pages, return instant page references
        if (options?.virtualize && totalPages > 10) {
            await this.closePdfSession();
            this.activePdfSession = {
                pdf,
                totalPages,
                base64Data
            };
            return Array.from({ length: totalPages }, (_, i) => `pdf:${i + 1}`);
        }

        const pages: string[] = [];
        const scale = options?.scale ?? 2.0;
        const quality = options?.quality ?? 0.92;
        const saveToFiles = options?.saveToTempFiles ?? (totalPages > 4);

        try {
            for (let i = 1; i <= totalPages; i++) {
                if (options?.abortSignal?.aborted) {
                    throw new DOMException('PDF extraction aborted', 'AbortError');
                }

                const page = await pdf.getPage(i);
                try {
                    let viewport = page.getViewport({ scale });
                    const maxDim = 2500;
                    if (viewport.width > maxDim || viewport.height > maxDim) {
                        const adjustedScale = Math.min(maxDim / (viewport.width / scale), maxDim / (viewport.height / scale));
                        viewport = page.getViewport({ scale: adjustedScale });
                    }

                    const canvas = document.createElement('canvas');
                    try {
                        canvas.width = viewport.width;
                        canvas.height = viewport.height;
                        const context = canvas.getContext('2d')!;

                        await page.render({
                            canvasContext: context,
                            viewport: viewport,
                            canvas: canvas
                        }).promise;

                        const dataUrl = canvas.toDataURL('image/jpeg', quality);

                        if (saveToFiles) {
                            const tempFileName = `temp_page_${Date.now()}_${i}_${Math.floor(Math.random() * 10000)}.jpg`;
                            await this.fs.writeFile({
                                path: tempFileName,
                                data: dataUrl,
                                directory: Directory.Cache
                            });
                            this.registerTempFile(tempFileName);
                            pages.push(tempFileName);
                        } else {
                            pages.push(dataUrl);
                        }
                    } finally {
                        releaseCanvas(canvas);
                    }
                } finally {
                    page.cleanup();
                }

                if (options?.onProgress) {
                    options.onProgress(i, totalPages);
                }

                if (i % 2 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            return pages;
        } finally {
            if (!this.activePdfSession || this.activePdfSession.pdf !== pdf) {
                try {
                    await pdf.cleanup();
                    await pdf.destroy();
                } catch (e) {
                    console.warn('PDF cleanup/destroy error:', e);
                }
            }
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
     * Pick multiple images from device photo gallery.
     */
    async pickImages(): Promise<GalleryPhotos> {
        return await Camera.pickImages({
            quality: 90,
            limit: 0
        });
    }

    /**
     * Convert a GalleryPhoto into a data URL for processing.
     */
    async readGalleryPhotoAsDataUrl(photo: GalleryPhoto): Promise<string> {
        if (photo.webPath) {
            const response = await fetch(photo.webPath);
            const blob = await response.blob();
            return await this.blobToDataUrl(blob);
        } else if (photo.path) {
            const file = await this.fs.readFile({
                path: photo.path
            });
            const ext = photo.format || 'jpeg';
            return `data:image/${ext};base64,${file.data}`;
        }
        throw new Error('No path available for gallery photo');
    }

    /**
     * Helper to convert Blob to base64 Data URL.
     */
    blobToDataUrl(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Helper to convert File to base64 Data URL.
     */
    fileToDataUrl(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /**
     * Loads an image from a Data URL or filesystem path into a canvas element.
     * Resizes the canvas to fit within maxWidth and bounded pixel limits (prevents browser canvas allocation failure).
     * 
     * @param canvas The HTMLCanvasElement to draw on.
     * @param dataUrlOrPath The base64 data URL or relative file path of the image.
     * @param maxWidth Maximum width in pixels (default: 2500px).
     * @returns Promise containing the original and working ImageDatas.
     */
    async loadImageToCanvas(
        canvas: HTMLCanvasElement,
        dataUrlOrPath: string,
        maxWidth: number = 2500
    ): Promise<{ original: ImageData, working: ImageData }> {
        const dataUrl = await this.resolvePageDataUrl(dataUrlOrPath);
        if (!dataUrl) {
            throw new Error(`Failed to resolve image data for canvas`);
        }

        return new Promise((resolve, reject) => {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                reject(new Error('Could not get canvas 2d context'));
                return;
            }

            const img = new Image();
            img.onload = () => {
                try {
                    let scale = Math.min(1, maxWidth / img.width);
                    let w = Math.round(img.width * scale);
                    let h = Math.round(img.height * scale);

                    // Clamp to max 16 Megapixels to prevent mobile GPU/canvas crashes
                    const MAX_PIXELS = 16000000;
                    if (w * h > MAX_PIXELS) {
                        const areaScale = Math.sqrt(MAX_PIXELS / (w * h));
                        w = Math.round(w * areaScale);
                        h = Math.round(h * areaScale);
                    }

                    canvas.width = Math.max(1, w);
                    canvas.height = Math.max(1, h);

                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                    // Free image element buffer
                    img.src = '';

                    const original = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const working = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    resolve({ original, working });
                } catch (err) {
                    // Recover gracefully from memory pressure
                    console.warn('Canvas allocation warning under memory pressure, retrying scaled:', err);
                    try {
                        canvas.width = Math.max(1, Math.round(canvas.width / 2));
                        canvas.height = Math.max(1, Math.round(canvas.height / 2));
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        img.src = '';
                        const original = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        const working = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        resolve({ original, working });
                    } catch (retryErr) {
                        img.src = '';
                        reject(retryErr);
                    }
                }
            };
            img.onerror = (err) => {
                img.src = '';
                reject(err);
            };
            img.src = dataUrl;
        });
    }

    /**
     * Fast, lightweight on-demand thumbnail generator.
     * Generates a small JPEG (~160px width, 0.65 quality, ~3KB) and immediately frees the temporary canvas.
     */
    async createThumbnail(dataUrlOrPath: string, maxWidth: number = 160, quality: number = 0.65): Promise<string> {
        if (dataUrlOrPath.startsWith('pdf:')) {
            const pageNum = parseInt(dataUrlOrPath.split(':')[1], 10);
            return await this.renderPdfSessionThumbnail(pageNum, maxWidth, quality);
        }

        const tempCanvas = document.createElement('canvas');
        try {
            await this.loadImageToCanvas(tempCanvas, dataUrlOrPath, maxWidth);
            return tempCanvas.toDataURL('image/jpeg', quality);
        } finally {
            releaseCanvas(tempCanvas);
        }
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
     * Ensures bounded memory and explicit resource destruction.
     * 
     * @param file The PDF file to process.
     * @param onPageProcessed Callback function called for each page with (imageDataUrl, pageNumber, totalPages).
     * @param options Optional configuration including abortSignal for cancellation.
     */
    async processPDFFile(
        file: File,
        onPageProcessed: (imageDataUrl: string, pageNum: number, totalPages: number) => void,
        options?: { abortSignal?: AbortSignal; scale?: number; quality?: number }
    ): Promise<void> {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const totalPages = pdf.numPages;
        const scale = options?.scale ?? 2.0;
        const quality = options?.quality ?? 0.92;

        try {
            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                if (options?.abortSignal?.aborted) {
                    throw new DOMException('PDF processing aborted', 'AbortError');
                }

                const page = await pdf.getPage(pageNum);
                try {
                    let viewport = page.getViewport({ scale });
                    const maxDim = 2500;
                    if (viewport.width > maxDim || viewport.height > maxDim) {
                        const adjustedScale = Math.min(maxDim / (viewport.width / scale), maxDim / (viewport.height / scale));
                        viewport = page.getViewport({ scale: adjustedScale });
                    }

                    const canvas = document.createElement('canvas');
                    try {
                        canvas.width = viewport.width;
                        canvas.height = viewport.height;
                        const context = canvas.getContext('2d')!;

                        await page.render({
                            canvasContext: context,
                            viewport: viewport,
                            canvas: canvas
                        }).promise;

                        const imageDataUrl = canvas.toDataURL('image/jpeg', quality);
                        onPageProcessed(imageDataUrl, pageNum, totalPages);
                    } finally {
                        releaseCanvas(canvas);
                    }
                } finally {
                    page.cleanup();
                }

                await new Promise(r => setTimeout(r, 0));
            }
        } finally {
            try {
                await pdf.cleanup();
                await pdf.destroy();
            } catch (e) {
                console.warn('PDF cleanup/destroy error:', e);
            }
        }
    }

    /**
     * Exports an array of images or an asynchronous page supplier as a PDF file.
     * Streams page-by-page to keep RAM bounded, supporting progress feedback and cancellation.
     * 
     * @param imagesOrProvider Array of image data URLs/file paths, or a page supplier function (index) => Promise<string | null>.
     * @param filename The name of the PDF file (without extension).
     * @param options Optional settings for progress reporting and abort signal.
     * @returns The PDF as a blob.
     */
    async exportAsPDF(
        imagesOrProvider: string[] | ((index: number) => Promise<string | null>),
        filename: string,
        options?: PDFExportOptions
    ): Promise<Blob> {
        const isArray = Array.isArray(imagesOrProvider);
        const count = isArray ? imagesOrProvider.length : (options?.totalPages ?? 0);

        if (count === 0) {
            throw new Error('No images to export');
        }

        // Create a new PDF document
        const pdfDoc = await PDFDocument.create();

        for (let i = 0; i < count; i++) {
            if (options?.abortSignal?.aborted) {
                throw new DOMException('PDF export was aborted', 'AbortError');
            }

            let imageData = isArray ? imagesOrProvider[i] : await imagesOrProvider(i);
            if (!imageData) continue;

            // If it's a file path or virtual page reference, resolve to data URL
            if (!imageData.startsWith('data:')) {
                const loaded = await this.resolvePageDataUrl(imageData);
                if (loaded) imageData = loaded;
                else continue;
            }

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

            // Evict temporary virtual page from cache to keep export heap footprint minimal
            if (isArray && imagesOrProvider[i].startsWith('pdf:')) {
                this.pageImageCache.delete(imagesOrProvider[i]);
            }

            if (options?.onProgress) {
                options.onProgress({
                    page: i + 1,
                    total: count,
                    percentage: Math.round(((i + 1) / count) * 100)
                });
            }

            // Yield to browser event loop
            if (i % 2 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
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
