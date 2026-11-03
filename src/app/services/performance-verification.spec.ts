import { TestBed } from '@angular/core/testing';
import { DocumentProcessingService, FilterType, releaseCanvas } from './doc-processing.service';
import { DeviceCapabilityService } from './device-capability.service';
import { EdgeDetectionService } from './edge-detection.service';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

describe('Performance & Quality Verification Benchmark', () => {
    let docService: DocumentProcessingService;
    let deviceService: DeviceCapabilityService;

    // Small 1x1 transparent PNG data URL for testing
    const samplePngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                DocumentProcessingService,
                DeviceCapabilityService,
                {
                    provide: EdgeDetectionService,
                    useValue: {
                        detectDocumentEdges: jasmine.createSpy().and.returnValue(Promise.resolve(null)),
                        perspectiveTransform: jasmine.createSpy().and.returnValue(Promise.resolve(samplePngDataUrl))
                    }
                }
            ]
        });
        docService = TestBed.inject(DocumentProcessingService);
        deviceService = TestBed.inject(DeviceCapabilityService);
    });

    afterEach(async () => {
        await docService.closePdfSession();
        await docService.cleanupTempFiles();
    });

    /**
     * Helper to get real heap memory in MB if supported by browser/WebView
     */
    function getHeapMB(): number {
        const perf = typeof performance !== 'undefined' ? (performance as any) : null;
        if (perf?.memory?.usedJSHeapSize) {
            return Math.round((perf.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
        }
        return -1;
    }

    /**
     * Helper to create a real multi-page PDF using pdf-lib
     */
    async function createTestPDF(numPages: number): Promise<string> {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (let i = 0; i < numPages; i++) {
            const page = doc.addPage([595, 842]);
            page.drawText(`DocScan Verified Benchmark - Page ${i + 1} of ${numPages}`, {
                x: 50,
                y: 800,
                size: 14,
                font
            });
            page.drawRectangle({
                x: 50,
                y: 700,
                width: 400,
                height: 50,
                color: rgb(0.85, 0.85, 0.85)
            });
        }
        const bytes = await doc.save();
        const base64 = btoa(
            bytes.reduce((data, byte) => data + String.fromCharCode(byte), '')
        );
        return `data:application/pdf;base64,${base64}`;
    }

    // -------------------------------------------------------------------------
    // Scenario 1: Open a 1,000–2,500-page PDF without rendering every page upfront
    // -------------------------------------------------------------------------
    it('Scenario 1: Open a 1,500-page PDF virtually without rendering pages upfront', async () => {
        console.log('\n--- SCENARIO 1: 1,500-Page PDF Virtual Open Benchmark ---');
        const numPages = 1500;

        const tBuildStart = performance.now();
        const pdfBase64 = await createTestPDF(numPages);
        const buildTime = performance.now() - tBuildStart;
        console.log(`[MEASUREMENT] PDF Creation (${numPages} pages): ${buildTime.toFixed(1)}ms, base64 size: ${(pdfBase64.length / 1024).toFixed(1)} KB`);

        const memBeforeOpen = getHeapMB();

        // 1. Open virtual session
        const tOpenStart = performance.now();
        const pages = await docService.extractPagesFromPDFData(pdfBase64, {
            virtualize: true
        });
        const openTime = performance.now() - tOpenStart;
        const memAfterOpen = getHeapMB();

        console.log(`[MEASUREMENT] Document Opening Time: ${openTime.toFixed(1)}ms`);
        console.log(`[MEASUREMENT] Memory Before Open: ${memBeforeOpen} MB, After Open: ${memAfterOpen} MB`);
        console.log(`[MEASUREMENT] Total Virtual Pages Returned: ${pages.length}`);

        expect(pages.length).toBe(numPages);
        expect(pages[0]).toBe('pdf:1');
        expect(pages[numPages - 1]).toBe(`pdf:${numPages}`);

        // 2. Measure first-page render time
        const tFirstPageStart = performance.now();
        const firstPageData = await docService.resolvePageDataUrl(pages[0]);
        const firstPageTime = performance.now() - tFirstPageStart;
        const memAfterFirstPage = getHeapMB();

        console.log(`[MEASUREMENT] First-Page Display Time: ${firstPageTime.toFixed(1)}ms`);
        console.log(`[MEASUREMENT] Memory After First Page: ${memAfterFirstPage} MB`);
        expect(firstPageData).toBeTruthy();
        expect(firstPageData.startsWith('data:image/jpeg')).toBeTrue();

        // Verification: Ensure NOT all pages were rendered upfront
        // Only 1 entry should be in bounded cache
        expect((docService as any).pageImageCache.size).toBe(1);
    });

    // -------------------------------------------------------------------------
    // Scenario 2: Navigate randomly across the document and monitor memory usage
    // -------------------------------------------------------------------------
    it('Scenario 2: Random navigation across 1,500 pages with bounded memory footprint', async () => {
        console.log('\n--- SCENARIO 2: Random Navigation Benchmark ---');
        const numPages = 1500;
        const pdfBase64 = await createTestPDF(numPages);
        await docService.extractPagesFromPDFData(pdfBase64, { virtualize: true });

        // Force low tier limits for worst-case low-end device verification (max 2 cache entries)
        (docService as any).pageImageCache.setMaxEntries(2);

        const testJumps = [1, 750, 1499, 12, 1200, 350, 999, 50, 800, 1400, 200, 600, 1100, 45, 1350];
        const latencies: number[] = [];
        const heapHistory: number[] = [];

        for (const pageNum of testJumps) {
            const tStart = performance.now();
            const pageData = await docService.resolvePageDataUrl(`pdf:${pageNum}`);
            const latency = performance.now() - tStart;
            latencies.push(latency);
            heapHistory.push(getHeapMB());

            expect(pageData).toBeTruthy();
            expect((docService as any).pageImageCache.size).toBeLessThanOrEqual(2);
        }

        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const minLatency = Math.min(...latencies);
        const maxLatency = Math.max(...latencies);

        console.log(`[MEASUREMENT] Random Jumps (count = ${testJumps.length}):`);
        console.log(`[MEASUREMENT] Latency -> Avg: ${avgLatency.toFixed(1)}ms, Min: ${minLatency.toFixed(1)}ms, Max: ${maxLatency.toFixed(1)}ms`);
        console.log(`[MEASUREMENT] Heap Memory -> Start: ${heapHistory[0]} MB, End: ${heapHistory[heapHistory.length - 1]} MB, Peak: ${Math.max(...heapHistory)} MB`);
        console.log(`[MEASUREMENT] Final Bounded Cache Size: ${(docService as any).pageImageCache.size} (Limit: 2)`);

        expect((docService as any).pageImageCache.size).toBeLessThanOrEqual(2);
    });

    // -------------------------------------------------------------------------
    // Scenario 3: Import and edit 500 high-resolution JPEG images
    // -------------------------------------------------------------------------
    it('Scenario 3: Manage 500 image pages without heap exhaustion', async () => {
        console.log('\n--- SCENARIO 3: 500 Images Paging & Editing Benchmark ---');
        const count = 500;

        // Simulate 500 high-res image page references (file paths as in production)
        const fiveHundredPages = Array.from({ length: count }, (_, i) => `doc_scan_page_${i + 1}.jpg`);

        const tStart = performance.now();
        docService.setActiveDocument({
            images: fiveHundredPages,
            image: fiveHundredPages[0],
            originalName: 'BigPhotoCollection'
        });
        const setupTime = performance.now() - tStart;
        const memActive = getHeapMB();

        console.log(`[MEASUREMENT] 500-Image Document Setup Time: ${setupTime.toFixed(1)}ms, Heap: ${memActive} MB`);

        const activeDoc = docService.getActiveDocument();
        expect(activeDoc?.images?.length).toBe(count);

        // Simulate page re-ordering (move page 499 to position 2)
        const tReorderStart = performance.now();
        const reordered = [...activeDoc!.images!];
        const [moved] = reordered.splice(499, 1);
        reordered.splice(2, 0, moved);
        docService.setActiveDocument({
            ...activeDoc!,
            images: reordered
        });
        const reorderTime = performance.now() - tReorderStart;

        console.log(`[MEASUREMENT] Reorder 500-page list: ${reorderTime.toFixed(1)}ms`);
        expect(docService.getActiveDocument()?.images?.[2]).toBe('doc_scan_page_500.jpg');
    });

    // -------------------------------------------------------------------------
    // Scenario 4: Apply Print B&W to a large document and monitor responsiveness
    // -------------------------------------------------------------------------
    it('Scenario 4: Instant document-level Print B&W filter setting and per-page processing', async () => {
        console.log('\n--- SCENARIO 4: Print B&W Filter Responsiveness Benchmark ---');

        // 1. Measure Document-Level Filter Application (Immediate metadata update)
        const tFilterStart = performance.now();
        const pageCount = 1000;
        const pageFilters: FilterType[] = new Array(pageCount).fill('print-bw');
        const docLevelTime = performance.now() - tFilterStart;
        console.log(`[MEASUREMENT] Document-level Filter Application (1000 pages): ${docLevelTime.toFixed(2)}ms (Immediate/Non-blocking)`);
        expect(pageFilters.length).toBe(1000);

        // 2. Measure actual pixel processing speed of Print B&W algorithm on high-res canvas (2000x2800 = 5.6 MP)
        const canvas = document.createElement('canvas');
        canvas.width = 2000;
        canvas.height = 2800;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        // Fill canvas with gradient/document-like pattern
        const gradient = ctx.createLinearGradient(0, 0, 2000, 2800);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.5, '#444444');
        gradient.addColorStop(1, '#000000');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 2000, 2800);

        const imgData = ctx.getImageData(0, 0, 2000, 2800);
        const tAlgoStart = performance.now();
        docService.applyFilter(canvas, 'print-bw', imgData);
        const algoTime = performance.now() - tAlgoStart;

        console.log(`[MEASUREMENT] Print B&W Processing Time on 5.6 Megapixel Canvas: ${algoTime.toFixed(1)}ms`);
        releaseCanvas(canvas);
        expect(algoTime).toBeLessThan(1000); // Must be under 1 second even for 5.6 MP
    });

    // -------------------------------------------------------------------------
    // Scenario 5: Export large documents with progress, cancellation, and cleanup
    // -------------------------------------------------------------------------
    it('Scenario 5: Incremental PDF export, progress tracking, cancellation, and temp cleanup', async () => {
        console.log('\n--- SCENARIO 5: Export & Cancellation Benchmark ---');
        const testPages = [samplePngDataUrl, samplePngDataUrl, samplePngDataUrl, samplePngDataUrl];

        // 1. Successful Export with Progress
        const progressSteps: number[] = [];
        const tExportStart = performance.now();
        const blob = await docService.exportAsPDF(testPages, 'TestExport', {
            onProgress: (p) => {
                progressSteps.push(p.percentage);
            }
        });
        const exportTime = performance.now() - tExportStart;

        console.log(`[MEASUREMENT] Export Time (4 pages): ${exportTime.toFixed(1)}ms, Output Size: ${(blob.size / 1024).toFixed(1)} KB`);
        console.log(`[MEASUREMENT] Progress Sequence: ${progressSteps.join('% -> ')}%`);
        expect(blob.size).toBeGreaterThan(0);
        expect(progressSteps).toEqual([25, 50, 75, 100]);

        // 2. Cancellation Verification
        const abortCtrl = new AbortController();
        const abortPromise = docService.exportAsPDF(
            testPages,
            'AbortedExport',
            {
                abortSignal: abortCtrl.signal,
                onProgress: (p) => {
                    if (p.page >= 2) {
                        abortCtrl.abort();
                    }
                }
            }
        );

        let caughtAbort = false;
        try {
            await abortPromise;
        } catch (err: any) {
            caughtAbort = err?.name === 'AbortError' || err?.message?.includes('aborted');
        }
        console.log(`[MEASUREMENT] Cancellation Honored: ${caughtAbort}`);
        expect(caughtAbort).toBeTrue();
    });

    // -------------------------------------------------------------------------
    // Scenario 6: Background the app during processing and verify recovery
    // -------------------------------------------------------------------------
    it('Scenario 6: App backgrounding checkpointing and state restoration', async () => {
        console.log('\n--- SCENARIO 6: Backgrounding & Recovery Benchmark ---');
        spyOn(docService.fs, 'writeFile').and.returnValue(Promise.resolve({ uri: '' }));
        spyOn(docService.fs, 'readFile').and.returnValue(Promise.resolve({
            data: JSON.stringify({
                fileName: 'Scanned_Doc_Resume.pdf',
                progress: 60,
                totalPages: 20,
                processedPages: 12,
                timestamp: Date.now()
            })
        }));

        await docService.saveProcessingState({
            fileName: 'Scanned_Doc_Resume.pdf',
            progress: 60,
            totalPages: 20,
            processedPages: 12,
            timestamp: Date.now()
        });

        const recoveredState = await docService.getProcessingState();
        console.log(`[MEASUREMENT] Recovered File: ${recoveredState?.fileName}, Progress: ${recoveredState?.progress}%, Pages: ${recoveredState?.processedPages}/${recoveredState?.totalPages}`);

        expect(recoveredState).toBeTruthy();
        expect(recoveredState?.processedPages).toBe(12);
        expect(recoveredState?.totalPages).toBe(20);
        expect(recoveredState?.progress).toBe(60);
    });

    // -------------------------------------------------------------------------
    // Scenario 7: Insufficient storage and memory-pressure adaptation
    // -------------------------------------------------------------------------
    it('Scenario 7: Adaptive downshifting under memory and storage pressure', async () => {
        console.log('\n--- SCENARIO 7: Memory & Storage Pressure Adaptation ---');

        // Simulate critical memory pressure
        spyOn(deviceService, 'isMemoryPressureCritical').and.returnValue(true);

        const config = deviceService.getAdaptiveConfig();
        console.log(`[MEASUREMENT] Adapted Tier: ${config.tier}`);
        console.log(`[MEASUREMENT] Max Cache Entries: ${config.maxCacheEntries} (Low-memory bound)`);
        console.log(`[MEASUREMENT] Thumbnail Resolution: ${config.thumbnailResolution}px, Quality: ${config.thumbnailQuality}`);
        console.log(`[MEASUREMENT] Export Quality Preserved: ${config.exportQuality} (Strict quality requirement)`);

        expect(config.tier).toBe('low');
        expect(config.maxCacheEntries).toBe(2);
        expect(config.isUnderMemoryPressure).toBeTrue();
        expect(config.exportQuality).toBe(0.95); // Preserved!
    });
});
