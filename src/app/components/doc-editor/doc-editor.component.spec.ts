import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DocEditorComponent } from './doc-editor.component';
import { DocumentProcessingService } from '../../services/doc-processing.service';
import { Router } from '@angular/router';

describe('DocEditorComponent - Multi-page', () => {
    let component: DocEditorComponent;
    let fixture: ComponentFixture<DocEditorComponent>;
    let docService: DocumentProcessingService;
    let router: jasmine.SpyObj<Router>;

    const samplePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    beforeEach(async () => {
        const routerSpy = jasmine.createSpyObj('Router', ['navigate']);

        await TestBed.configureTestingModule({
            imports: [DocEditorComponent],
            providers: [
                DocumentProcessingService,
                { provide: Router, useValue: routerSpy }
            ]
        }).compileComponents();

        docService = TestBed.inject(DocumentProcessingService);
        router = TestBed.inject(Router) as jasmine.SpyObj<Router>;

        // Set up active document with 3 pages
        docService.setActiveDocument({
            images: [samplePng, samplePng, samplePng],
            image: samplePng,
            originalName: 'MultiPageDoc',
            pageFilters: ['original', 'grayscale', 'sepia'],
            currentPage: 0
        });

        fixture = TestBed.createComponent(DocEditorComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create and load 3 pages', () => {
        expect(component).toBeTruthy();
        expect(component.totalPages).toBe(3);
        expect(component.currentPage).toBe(0);
        expect(component.pageFilters.length).toBe(3);
        expect(component.pageFilters[0]).toBe('original');
        expect(component.pageFilters[1]).toBe('grayscale');
        expect(component.pageFilters[2]).toBe('sepia');
    });

    it('should navigate between pages', async () => {
        expect(component.currentPage).toBe(0);

        await component.nextPage();
        expect(component.currentPage).toBe(1);
        expect(component.activeFilter).toBe('grayscale');

        await component.nextPage();
        expect(component.currentPage).toBe(2);
        expect(component.activeFilter).toBe('sepia');

        await component.prevPage();
        expect(component.currentPage).toBe(1);

        await component.selectPage(0);
        expect(component.currentPage).toBe(0);
    });

    it('should not contain MOVE buttons in the toolbar', () => {
        const toolbar = fixture.nativeElement.querySelector('.page-toolbar');
        expect(toolbar).toBeTruthy();
        expect(toolbar.textContent).not.toContain('Move');
    });

    it('should reorder pages via reorderPage', () => {
        expect(component.pageFilters).toEqual(['original', 'grayscale', 'sepia']);

        // Move page 0 to position 2
        component.reorderPage(0, 2);
        expect(component.pageFilters).toEqual(['grayscale', 'sepia', 'original']);
        expect(component.currentPage).toBe(2);

        // Move page 2 back to position 0
        component.reorderPage(2, 0);
        expect(component.pageFilters).toEqual(['original', 'grayscale', 'sepia']);
        expect(component.currentPage).toBe(0);
    });

    it('should reorder pages via drag and drop', () => {
        component.draggedIndex = 0;
        const mockDropEvent = {
            preventDefault: jasmine.createSpy('preventDefault'),
            dataTransfer: null
        } as any;

        component.onDrop(mockDropEvent, 2);
        expect(component.pageFilters).toEqual(['grayscale', 'sepia', 'original']);
        expect(component.draggedIndex).toBeNull();
    });

    it('should reorder pages via touch drag on thumbnail strip', () => {
        // Touch start on index 1
        component.onTouchStart({} as any, 1);
        (component as any).touchTargetIndex = 0;
        (component as any).touchMoved = true;

        component.onTouchEnd();
        expect(component.pageFilters).toEqual(['grayscale', 'original', 'sepia']);
    });

    it('should automatically apply selected filter to all pages in the document', () => {
        component.currentPage = 0;
        component.selectFilter('high-contrast');

        expect(component.activeFilter).toBe('high-contrast');
        expect(component.pageFilters).toEqual(['high-contrast', 'high-contrast', 'high-contrast']);
    });

    it('should not contain filter label or apply to all pages button in the template', () => {
        const filterContainer = fixture.nativeElement.querySelector('.filter-controls-container');
        expect(filterContainer).toBeTruthy();
        expect(filterContainer.textContent).not.toContain('Filter: Page');
        expect(filterContainer.textContent).not.toContain('Apply to all pages');
        expect(filterContainer.textContent).not.toContain('Filters');
    });

    it('should delete a page when confirmed', async () => {
        expect(component.totalPages).toBe(3);
        component.currentPage = 1;

        // Spy on alert to trigger the delete handler
        const alertCtrl = (component as any).alertCtrl;
        spyOn(alertCtrl, 'create').and.callFake((options: any) => {
            return Promise.resolve({
                present: () => {
                    const deleteBtn = options.buttons.find((b: any) => b.text === 'Delete');
                    if (deleteBtn && deleteBtn.handler) {
                        deleteBtn.handler();
                    }
                    return Promise.resolve();
                }
            });
        });

        await component.deleteCurrentPage();
        expect(component.totalPages).toBe(2);
        expect(component.pageFilters.length).toBe(2);
    });

    it('should save multi-page document as PDF', async () => {
        spyOn(docService, 'saveProcessedDocument').and.returnValue(Promise.resolve());

        await component.save();

        expect(docService.saveProcessedDocument).toHaveBeenCalledWith(
            jasmine.any(Array),
            'MultiPageDoc',
            'pdf',
            jasmine.any(String)
        );
        expect(router.navigate).toHaveBeenCalledWith(['/home'], { replaceUrl: true });
    });

    it('should navigate to edge-adjust with detected edges when cropCurrentPage is called', async () => {
        spyOn(docService, 'detectDocumentEdges').and.returnValue(Promise.resolve([
            { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }
        ]));

        component.currentPage = 1;
        await component.cropCurrentPage();

        const state = docService.getEdgeDetectionState();
        expect(state).toBeTruthy();
        expect(state?.pageIndex).toBe(1);
        expect(router.navigate).toHaveBeenCalledWith(['/edge-adjust']);
    });

    it('should refresh cropped image and preview on ionViewWillEnter', async () => {
        // First ensure initial previews are loaded
        await component.ionViewWillEnter();
        const initialPreview0 = component.allPreviewData[0];
        const croppedPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

        // Simulate returning from crop of page 1
        const activeDoc = docService.getActiveDocument()!;
        activeDoc.images = [samplePng, croppedPng, samplePng];
        activeDoc.currentPage = 1;
        docService.setActiveDocument(activeDoc);

        await component.ionViewWillEnter();

        expect(component.currentPage).toBe(1);
        // Page 0 preview should be untouched
        expect(component.allPreviewData[0]).toBe(initialPreview0);
        // Page 1 should have regenerated preview and high-res data updated
        expect((component as any).allFullResData[1]).toBe(croppedPng);
        expect(component.allPreviewData[1]).toBeTruthy();
    });

    it('should not mutate images if active document is unchanged on ionViewWillEnter', async () => {
        // Ensure initial previews are loaded
        await component.ionViewWillEnter();
        const initialPreviews = [...component.allPreviewData];

        // Call ionViewWillEnter without changing activeDoc
        await component.ionViewWillEnter();

        expect(component.allPreviewData).toEqual(initialPreviews);
    });

    it('should support large documents with sliding window thumbnails and close session on cancel', async () => {
        spyOn(docService, 'closePdfSession').and.returnValue(Promise.resolve());
        spyOn(docService, 'createThumbnail').and.returnValue(Promise.resolve('thumb_data'));

        // Setup 100-page document
        const hundredPages = Array.from({ length: 100 }, (_, i) => `pdf:${i + 1}`);
        docService.setActiveDocument({
            images: hundredPages,
            image: hundredPages[0],
            originalName: 'HugeDoc',
            currentPage: 50
        });

        const largeFixture = TestBed.createComponent(DocEditorComponent);
        const largeComp = largeFixture.componentInstance;
        largeFixture.detectChanges();

        expect(largeComp.totalPages).toBe(100);
        expect(largeComp.allPreviewData.length).toBe(100);

        // Cancel should close PDF session and clean up
        largeComp.cancel();
        expect(docService.closePdfSession).toHaveBeenCalled();
    });

    it('should evict off-screen thumbnails under critical memory pressure', async () => {
        spyOn(docService, 'createThumbnail').and.returnValue(Promise.resolve('thumb_data'));
        spyOn(component.deviceCapabilityService, 'isMemoryPressureCritical').and.returnValue(true);

        component.totalPages = 50;
        component.currentPage = 40;
        component.allPreviewData = new Array(50).fill('cached_thumb');

        await component.ensureThumbnailsForWindow(40);

        // Thumbnails far from page 40 (e.g. page 0, 5, 10) should be evicted to empty string
        expect(component.allPreviewData[0]).toBe('');
        expect(component.allPreviewData[5]).toBe('');
        // Current page and nearby pages should remain loaded
        expect(component.allPreviewData[40]).toBe('cached_thumb');
    });
});

