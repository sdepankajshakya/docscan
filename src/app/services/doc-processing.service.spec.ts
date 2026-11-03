import { TestBed } from '@angular/core/testing';
import { DocumentProcessingService, FilterType, releaseCanvas } from './doc-processing.service';
import { EdgeDetectionService } from './edge-detection.service';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { PDFDocument } from 'pdf-lib';

describe('DocumentProcessingService - Multi-page', () => {
    let service: DocumentProcessingService;

    // Small 1x1 transparent PNG data URL for testing
    const samplePngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                DocumentProcessingService,
                {
                    provide: EdgeDetectionService,
                    useValue: {
                        detectDocumentEdges: jasmine.createSpy('detectDocumentEdges').and.returnValue(Promise.resolve(null)),
                        perspectiveTransform: jasmine.createSpy('perspectiveTransform').and.returnValue(Promise.resolve(samplePngDataUrl))
                    }
                }
            ]
        });
        service = TestBed.inject(DocumentProcessingService);
    });

    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    it('should set and get multi-page active document state', () => {
        const pages = [samplePngDataUrl, samplePngDataUrl];
        const pageFilters: FilterType[] = ['grayscale', 'sepia'];

        service.setActiveDocument({
            images: pages,
            image: pages[0],
            originalName: 'TestDoc',
            pageFilters: pageFilters,
            currentPage: 1
        });

        const active = service.getActiveDocument();
        expect(active).toBeTruthy();
        expect(active?.images?.length).toBe(2);
        expect(active?.pageFilters).toEqual(['grayscale', 'sepia']);
        expect(active?.currentPage).toBe(1);
    });

    it('should set and get edge detection state with session pages', () => {
        service.setEdgeDetectionState({
            imageData: samplePngDataUrl,
            sessionPages: [samplePngDataUrl],
            isMultiScan: true,
            pageIndex: 0
        });

        const edgeState = service.getEdgeDetectionState();
        expect(edgeState).toBeTruthy();
        expect(edgeState?.sessionPages?.length).toBe(1);
        expect(edgeState?.isMultiScan).toBeTrue();
        expect(edgeState?.pageIndex).toBe(0);
    });

    it('should convert blob to data URL', async () => {
        const blob = new Blob(['hello world'], { type: 'text/plain' });
        const dataUrl = await service.blobToDataUrl(blob);
        expect(dataUrl).toContain('data:text/plain;base64,');
    });

    it('should convert file to data URL', async () => {
        const file = new File(['image content'], 'test.jpg', { type: 'image/jpeg' });
        const dataUrl = await service.fileToDataUrl(file);
        expect(dataUrl).toContain('data:image/jpeg;base64,');
    });

    it('should export multiple images as PDF blob', async () => {
        const images = [samplePngDataUrl, samplePngDataUrl];
        const pdfBlob = await service.exportAsPDF(images, 'multi_test');
        expect(pdfBlob).toBeTruthy();
        expect(pdfBlob.type).toBe('application/pdf');
        expect(pdfBlob.size).toBeGreaterThan(0);
    });

    it('should report progress during incremental PDF export', async () => {
        const images = [samplePngDataUrl, samplePngDataUrl];
        const progressEvents: any[] = [];

        await service.exportAsPDF(images, 'progress_test', {
            onProgress: (p) => progressEvents.push(p)
        });

        expect(progressEvents.length).toBe(2);
        expect(progressEvents[0].page).toBe(1);
        expect(progressEvents[1].page).toBe(2);
        expect(progressEvents[1].percentage).toBe(100);
    });

    it('should support cancellation during PDF export via AbortSignal', async () => {
        const images = [samplePngDataUrl, samplePngDataUrl, samplePngDataUrl];
        const abortController = new AbortController();

        // Abort before starting
        abortController.abort();

        try {
            await service.exportAsPDF(images, 'cancel_test', {
                abortSignal: abortController.signal
            });
            fail('Expected export to throw AbortError');
        } catch (e: any) {
            expect(e.name).toBe('AbortError');
        }
    });

    it('should release canvas dimensions to free GPU memory', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;

        releaseCanvas(canvas);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
    });

    it('should create lightweight thumbnail using createThumbnail', async () => {
        const thumb = await service.createThumbnail(samplePngDataUrl, 160, 0.65);
        expect(thumb).toBeTruthy();
        expect(thumb.startsWith('data:image/jpeg')).toBeTrue();
    });

    it('should manage and clean up temporary session files and close active PDF session', async () => {
        service.registerTempFile('temp_test_1.jpg');
        spyOn(service, 'closePdfSession').and.returnValue(Promise.resolve());
        await service.cleanupTempFiles();
        expect((service as any).tempSessionFiles.size).toBe(0);
        expect(service.closePdfSession).toHaveBeenCalled();
    });

    it('should adapt bounded memory cache limits based on device capability', () => {
        spyOn(service.deviceCapabilityService, 'getAdaptiveConfig').and.returnValue({
            tier: 'low',
            maxCacheEntries: 2,
            previewResolution: 1000,
            thumbnailResolution: 140,
            thumbnailQuality: 0.55,
            thumbnailBatchSize: 1,
            thumbnailYieldMs: 16,
            exportScale: 2.0,
            exportQuality: 0.95,
            isUnderMemoryPressure: true,
            isUnderStoragePressure: false
        });

        service.adaptCacheLimits();
        expect((service as any).pageImageCache.maxEntries).toBe(2);
    });

    it('should resolve virtual PDF page references using active PDF session', async () => {
        spyOn(service, 'renderPdfSessionPage').and.returnValue(Promise.resolve(samplePngDataUrl));

        const resolved = await service.resolvePageDataUrl('pdf:5');
        expect(resolved).toBe(samplePngDataUrl);
        expect(service.renderPdfSessionPage).toHaveBeenCalledWith(5);

        // Subsequent call should hit bounded cache
        const cached = await service.resolvePageDataUrl('pdf:5');
        expect(cached).toBe(samplePngDataUrl);
        expect((service.renderPdfSessionPage as jasmine.Spy).calls.count()).toBe(1);
    });

    it('should create thumbnail from virtual PDF page reference', async () => {
        spyOn(service, 'renderPdfSessionThumbnail').and.returnValue(Promise.resolve(samplePngDataUrl));

        const thumb = await service.createThumbnail('pdf:12', 140, 0.55);
        expect(thumb).toBe(samplePngDataUrl);
        expect(service.renderPdfSessionThumbnail).toHaveBeenCalledWith(12, 140, 0.55);
    });

    describe('Document Storage & Data Safety', () => {
        it('should safely abort write if temp file validation fails and leave primary catalog intact', async () => {
            (service as any)._isCatalogLoaded = true;
            (service as any)._documents = [
                { name: 'Doc1', date: '2026-11-03', thumbnail: 'thumb1.jpg', fullImage: 'doc1.jpg' }
            ];

            let tmpDeleted = false;
            spyOn(service.fs, 'writeFile').and.returnValue(Promise.resolve({ uri: '' }));
            // Return corrupt data when reading back temp file for validation
            spyOn(service.fs, 'readFile').and.returnValue(Promise.resolve({ data: 'invalid JSON {' }));
            spyOn(service.fs, 'deleteFile').and.callFake((options: any) => {
                if (options.path === 'documents.json.tmp') {
                    tmpDeleted = true;
                }
                return Promise.resolve();
            });
            spyOn(service.fs, 'rename').and.returnValue(Promise.resolve());

            try {
                await service.saveDocumentsList();
                fail('Expected saveDocumentsList to throw validation error');
            } catch (err: any) {
                expect(err.message).toContain('Catalog write aborted');
                expect(tmpDeleted).toBeTrue();
                expect(service.fs.rename).not.toHaveBeenCalled();
            }
        });

        it('should recover from backup and preserve corrupted primary catalog when corrupted metadata is detected', async () => {
            let corruptedSaved = false;
            spyOn(service.fs, 'readFile').and.callFake((options: any) => {
                if (options.path === 'documents.json') {
                    return Promise.resolve({ data: 'corrupted JSON {{{' });
                }
                if (options.path === 'documents.json.bak') {
                    return Promise.resolve({
                        data: JSON.stringify([
                            { name: 'RecoveredDoc', date: '2026-11-03', thumbnail: 'thumb.jpg', fullImage: 'doc.jpg' }
                        ])
                    });
                }
                return Promise.reject(new Error('File not found'));
            });

            spyOn(service.fs, 'writeFile').and.callFake((options: any) => {
                if (options.path.startsWith('documents_corrupted_')) {
                    corruptedSaved = true;
                }
                return Promise.resolve({ uri: '' });
            });
            spyOn(service, 'saveDocumentsList').and.returnValue(Promise.resolve());

            await service.loadDocuments();

            expect(corruptedSaved).toBeTrue();
            expect(service.catalogLoadStatus).toBe('recovered_from_bak');
            expect(service.documents.length).toBe(1);
            expect(service.documents[0].name).toBe('RecoveredDoc');
        });

        it('should not reset document catalog to empty array on transient filesystem read error', async () => {
            (service as any)._isCatalogLoaded = true;
            (service as any)._documents = [
                { name: 'ExistingDoc', date: '2026-11-03', thumbnail: 't.jpg', fullImage: 'd.jpg' }
            ];

            // Simulate transient filesystem permission/lock error (NOT "file does not exist")
            spyOn(service.fs, 'readFile').and.returnValue(Promise.reject(new Error('EACCES: permission denied, read lock active')));

            await service.loadDocuments();

            expect(service.catalogLoadStatus).toBe('transient_error');
            // Existing catalog must NOT be cleared!
            expect(service.documents.length).toBe(1);
            expect(service.documents[0].name).toBe('ExistingDoc');
        });

        it('should prevent saveDocumentsList if catalog has not been safely loaded', async () => {
            (service as any)._isCatalogLoaded = false;

            try {
                await service.saveDocumentsList();
                fail('Expected saveDocumentsList to throw safety check guard error');
            } catch (err: any) {
                expect(err.message).toContain('Safety guard');
            }
        });

        it('should recover orphan documents conservatively and preserve multi-page PDF relationships', async () => {
            spyOn(service.fs, 'readFile').and.callFake((options: any) => {
                if (options.path === 'documents.json' || options.path === 'documents.json.bak') {
                    return Promise.reject(new Error('File does not exist'));
                }
                if (options.path === 'doc_1730000000_1.pdf') {
                    // Simulated PDF with 3 pages (/Type /Page)
                    const mockPdfString = '... /Type /Page ... /Type /Page ... /Type /Page ...';
                    return Promise.resolve({ data: btoa(mockPdfString) });
                }
                return Promise.resolve({ data: samplePngDataUrl });
            });

            spyOn(service.fs, 'readdir').and.returnValue(Promise.resolve({
                files: [
                    'doc_1730000000_1.pdf',
                    'doc_1730000000_2.jpg',
                    'unknown_file.bin' // Unknown file should be ignored
                ] as any
            }));

            spyOn(service, 'createThumbnail').and.returnValue(Promise.resolve(samplePngDataUrl));
            spyOn(service.fs, 'writeFile').and.returnValue(Promise.resolve({ uri: '' }));
            spyOn(service, 'saveDocumentsList').and.returnValue(Promise.resolve());

            await service.loadDocuments();

            expect(service.catalogLoadStatus).toBe('recovered_orphans');
            expect(service.documents.length).toBe(2);

            const pdfDoc = service.documents.find(d => d.type === 'pdf');
            expect(pdfDoc).toBeTruthy();
            expect(pdfDoc?.pageCount).toBe(3);
            expect(pdfDoc?.name).toContain('Recovered_doc_1730000000_1');

            const imgDoc = service.documents.find(d => d.type === 'image');
            expect(imgDoc).toBeTruthy();
            expect(imgDoc?.name).toContain('Recovered_doc_1730000000_2');
        });

        it('should never delete unidentified or unknown files during orphan recovery', async () => {
            spyOn(service.fs, 'readdir').and.returnValue(Promise.resolve({
                files: [
                    'unidentified_system.dat',
                    'custom_notes.txt',
                    'random_binary.bin'
                ] as any
            }));
            spyOn(service.fs, 'deleteFile');

            const orphans = await service.recoverOrphanDocuments();

            expect(orphans.length).toBe(0);
            expect(service.fs.deleteFile).not.toHaveBeenCalled();
        });

        it('should execute restartable migrations and preserve original thumbnails until verified', async () => {
            (service as any)._isCatalogLoaded = true;
            const docNeedingMigration = {
                name: 'LegacyDoc',
                date: '2026-11-03',
                thumbnail: 'data:image/jpeg;base64,legacyThumbnailData',
                fullImage: 'doc_legacy.jpg'
            };
            (service as any)._documents = [docNeedingMigration];

            spyOn(service.fs, 'writeFile').and.returnValue(Promise.resolve({ uri: '' }));
            spyOn(service.fs, 'stat').and.returnValue(Promise.resolve({ name: 'file', size: 1024, mtime: Date.now(), ctime: Date.now(), type: 'file', uri: '' }));
            spyOn(service, 'saveDocumentsList').and.returnValue(Promise.resolve());
            const deleteSpy = spyOn(service.fs, 'deleteFile').and.returnValue(Promise.resolve());

            await (service as any).executeSafeMigrations();

            expect(docNeedingMigration.thumbnail?.startsWith('thumb_')).toBeTrue();
            // migration_state.json should be cleaned up on verified completion
            expect(deleteSpy).toHaveBeenCalledWith(jasmine.objectContaining({ path: 'migration_state.json' }));
        });

        it('should not delete old files in updateDocument if new files fail verification', async () => {
            (service as any)._isCatalogLoaded = true;
            const originalDoc = {
                name: 'DocToUpdate',
                date: '2026-11-03',
                thumbnail: 'thumb_old.jpg',
                fullImage: 'doc_old.jpg'
            };

            spyOn(service.fs, 'writeFile').and.returnValue(Promise.resolve({ uri: '' }));
            // Return size 0 to simulate failed/corrupted write
            spyOn(service.fs, 'stat').and.returnValue(Promise.resolve({ name: 'file', size: 0, mtime: Date.now(), ctime: Date.now(), type: 'file', uri: '' }));
            const deleteSpy = spyOn(service.fs, 'deleteFile');

            try {
                await service.updateDocument(originalDoc, samplePngDataUrl, samplePngDataUrl);
                fail('Expected updateDocument to fail verification');
            } catch (err: any) {
                expect(err.message.toLowerCase()).toContain('verif');
                // Original files must NOT have been deleted!
                expect(deleteSpy).not.toHaveBeenCalledWith(jasmine.objectContaining({ path: 'doc_old.jpg' }));
                expect(deleteSpy).not.toHaveBeenCalledWith(jasmine.objectContaining({ path: 'thumb_old.jpg' }));
            }
        });

        it('should support Storage Access Framework in saveDocumentAs and handle user abort cleanly', async () => {
            const doc = {
                name: 'ExportTest',
                date: '2026-11-03',
                thumbnail: 'thumb_1.jpg',
                fullImage: samplePngDataUrl,
                type: 'image' as const
            };

            // Mock window.showSaveFilePicker with user cancellation
            const abortErr = new DOMException('The user aborted a request', 'AbortError');
            (window as any).showSaveFilePicker = jasmine.createSpy('showSaveFilePicker').and.returnValue(Promise.reject(abortErr));

            const result = await service.saveDocumentAs(doc, 'image');

            expect(result.success).toBeFalse();
            expect(result.message).toContain('Export cancelled by user');

            delete (window as any).showSaveFilePicker;
        });

        it('should recover catalog from documents.json.tmp if primary documents.json is corrupted or interrupted', async () => {
            spyOn(service.fs, 'readFile').and.callFake((options: any) => {
                if (options.path === 'documents.json') {
                    return Promise.resolve({ data: 'truncated/corrupt JSON {' });
                }
                if (options.path === 'documents.json.tmp') {
                    return Promise.resolve({
                        data: JSON.stringify({
                            version: 2,
                            lastSaved: Date.now(),
                            documents: [
                                { name: 'RecoveredFromTmpDoc', date: '2026-11-03', thumbnail: 'thumb_t.jpg', fullImage: 'doc_t.jpg' }
                            ]
                        })
                    });
                }
                return Promise.reject(new Error('File not found'));
            });

            spyOn(service.fs, 'writeFile').and.returnValue(Promise.resolve({ uri: '' }));
            spyOn(service, 'saveDocumentsList').and.returnValue(Promise.resolve());

            await service.loadDocuments();

            expect(service.catalogLoadStatus).toBe('recovered_from_tmp');
            expect(service.documents.length).toBe(1);
            expect(service.documents[0].name).toBe('RecoveredFromTmpDoc');
            expect(service.saveDocumentsList).toHaveBeenCalled();
        });

        it('should preserve .tmp and .bak without deleting them if primary write verification fails', async () => {
            (service as any)._isCatalogLoaded = true;
            (service as any)._documents = [
                { name: 'DocToSave', date: '2026-11-03', thumbnail: 'thumb1.jpg', fullImage: 'doc1.jpg' }
            ];

            const deletedFiles: string[] = [];
            spyOn(service.fs, 'writeFile').and.returnValue(Promise.resolve({ uri: '' }));

            // Simulate step 5 verification failure when reading back documents.json
            let readCount = 0;
            spyOn(service.fs, 'readFile').and.callFake((options: any) => {
                if (options.path === 'documents.json.tmp') {
                    return Promise.resolve({
                        data: JSON.stringify({
                            version: 2,
                            lastSaved: Date.now(),
                            documents: (service as any)._documents
                        })
                    });
                }
                if (options.path === 'documents.json') {
                    readCount++;
                    if (readCount === 1) {
                        // First read for backup
                        return Promise.resolve({ data: '{"version": 1, "documents": []}' });
                    }
                    // Second read for post-write verification returns corrupt/empty data
                    return Promise.resolve({ data: 'corrupted_write' });
                }
                return Promise.reject(new Error('File not found'));
            });

            spyOn(service.fs, 'deleteFile').and.callFake((options: any) => {
                deletedFiles.push(options.path);
                return Promise.resolve();
            });

            try {
                await service.saveDocumentsList();
                fail('Expected verification error');
            } catch (err: any) {
                expect(err.message).toContain('verification failed');
                // documents.json.tmp MUST NOT have been deleted!
                expect(deletedFiles).not.toContain('documents.json.tmp');
            }
        });

        it('should invoke NativeStorageExport.exportWithSAF on Android platform and return success', async () => {
            spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
            spyOn(Capacitor, 'getPlatform').and.returnValue('android');
            spyOn(window, 'alert');

            spyOn(service.nativeStorage, 'exportWithSAF').and.returnValue(Promise.resolve({
                success: true,
                uri: 'content://com.android.providers.media.documents/document/1234',
                message: 'File saved successfully'
            }));

            const doc = {
                name: 'AndroidExportDoc',
                date: '2026-11-03',
                thumbnail: 'thumb.jpg',
                fullImage: samplePngDataUrl,
                type: 'image' as const
            };

            const result = await service.saveDocumentAs(doc, 'image');

            expect(result.success).toBeTrue();
            expect(result.path).toContain('1234');
            expect(service.nativeStorage.exportWithSAF).toHaveBeenCalled();
        });

        it('should handle user cancellation from NativeStorageExport.exportWithSAF on Android cleanly', async () => {
            spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
            spyOn(Capacitor, 'getPlatform').and.returnValue('android');

            spyOn(service.nativeStorage, 'exportWithSAF').and.returnValue(Promise.resolve({
                success: false,
                cancelled: true,
                message: 'Export cancelled by user'
            }));
            const mediaSpy = spyOn(service.nativeStorage, 'exportToMediaStore');

            const doc = {
                name: 'CancelledDoc',
                date: '2026-11-03',
                thumbnail: 'thumb.jpg',
                fullImage: samplePngDataUrl,
                type: 'image' as const
            };

            const result = await service.saveDocumentAs(doc, 'image');

            expect(result.success).toBeFalse();
            expect(result.message).toContain('Export cancelled by user');
            // Must NOT fallback to MediaStore when user explicitly cancelled SAF
            expect(mediaSpy).not.toHaveBeenCalled();
        });

        it('should fallback to NativeStorageExport.exportToMediaStore if SAF fails on Android', async () => {
            spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
            spyOn(Capacitor, 'getPlatform').and.returnValue('android');
            spyOn(window, 'alert');

            spyOn(service.nativeStorage, 'exportWithSAF').and.returnValue(Promise.reject(new Error('SAF Activity not available')));
            spyOn(service.nativeStorage, 'exportToMediaStore').and.returnValue(Promise.resolve({
                success: true,
                path: 'Documents/FallbackDoc_saved.jpg',
                message: 'File saved via MediaStore'
            }));

            const doc = {
                name: 'FallbackDoc',
                date: '2026-11-03',
                thumbnail: 'thumb.jpg',
                fullImage: samplePngDataUrl,
                type: 'image' as const
            };

            const result = await service.saveDocumentAs(doc, 'image');

            expect(result.success).toBeTrue();
            expect(result.path).toContain('Documents/FallbackDoc');
            expect(service.nativeStorage.exportToMediaStore).toHaveBeenCalled();
        });

        it('should determine page count of orphan PDF using getPdfPageCount without regex or loading entire string', async () => {
            // Generate a real 3-page PDF binary with pdf-lib to test binary xref parsing
            const pdfDoc = await PDFDocument.create();
            pdfDoc.addPage([200, 200]);
            pdfDoc.addPage([200, 200]);
            pdfDoc.addPage([200, 200]);
            const pdfBytes = await pdfDoc.save();
            const base64Pdf = btoa(String.fromCharCode.apply(null, Array.from(pdfBytes)));

            spyOn(service.fs, 'getUri').and.returnValue(Promise.reject(new Error('No URI')));
            spyOn(service.fs, 'readFile').and.returnValue(Promise.resolve({ data: base64Pdf }));

            const pageCount = await service.getPdfPageCount('doc_large_orphan.pdf');

            expect(pageCount).toBe(3);
        });

        it('should skip duplicate orphan files with matching signatures without deleting them from disk', async () => {
            (service as any)._documents = [
                { name: 'ExistingDoc', date: '2026-11-03', thumbnail: 'thumb_exist.jpg', fullImage: 'doc_existing.jpg' }
            ];

            // Existing doc has size 54321
            // Candidate orphan 1 has size 54321 (duplicate of existing doc)
            // Candidate orphan 2 has size 99999 (unique orphan)
            // Candidate orphan 3 has size 99999 (duplicate of orphan 2)
            spyOn(service.fs, 'stat').and.callFake((options: any) => {
                if (options.path === 'doc_existing.jpg' || options.path === 'doc_dup_of_existing.jpg') {
                    return Promise.resolve({ size: 54321, mtime: Date.now() } as any);
                }
                if (options.path === 'doc_unique.jpg' || options.path === 'doc_dup_of_unique.jpg') {
                    return Promise.resolve({ size: 99999, mtime: Date.now() } as any);
                }
                return Promise.reject(new Error('File not found'));
            });

            spyOn(service.fs, 'readdir').and.returnValue(Promise.resolve({
                files: [
                    'doc_dup_of_existing.jpg',
                    'doc_unique.jpg',
                    'doc_dup_of_unique.jpg'
                ] as any
            }));

            spyOn(service, 'createThumbnail').and.returnValue(Promise.resolve(samplePngDataUrl));
            spyOn(service.fs, 'writeFile').and.returnValue(Promise.resolve({ uri: '' }));
            const deleteSpy = spyOn(service.fs, 'deleteFile');

            const orphans = await service.recoverOrphanDocuments();

            // Only doc_unique.jpg should be recovered; the two duplicates must be skipped
            expect(orphans.length).toBe(1);
            expect(orphans[0].fullImage).toBe('doc_unique.jpg');
            // Duplicate files MUST NOT be deleted from disk
            expect(deleteSpy).not.toHaveBeenCalledWith(jasmine.objectContaining({ path: 'doc_dup_of_existing.jpg' }));
            expect(deleteSpy).not.toHaveBeenCalledWith(jasmine.objectContaining({ path: 'doc_dup_of_unique.jpg' }));
        });
    });
});

