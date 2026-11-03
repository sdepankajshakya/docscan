import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EdgeAdjustComponent } from './edge-adjust.component';
import { DocumentProcessingService } from '../../services/doc-processing.service';
import { provideRouter, Router } from '@angular/router';

describe('EdgeAdjustComponent - Multi-page scanning & cropping', () => {
    let component: EdgeAdjustComponent;
    let fixture: ComponentFixture<EdgeAdjustComponent>;
    let docService: DocumentProcessingService;
    let router: Router;

    const samplePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [EdgeAdjustComponent],
            providers: [
                DocumentProcessingService,
                provideRouter([])
            ]
        }).compileComponents();

        docService = TestBed.inject(DocumentProcessingService);
        router = TestBed.inject(Router);
        spyOn(router, 'navigate').and.returnValue(Promise.resolve(true));
    });

    it('should initialize with multi-page scan state', () => {
        docService.setEdgeDetectionState({
            imageData: samplePng,
            sessionPages: [samplePng],
            isMultiScan: true
        });

        fixture = TestBed.createComponent(EdgeAdjustComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();

        expect(component).toBeTruthy();
        expect(component.sessionPages.length).toBe(1);
        expect(component.pageTitle).toContain('Page 2');
    });

    it('should initialize in page crop mode when pageIndex is provided', () => {
        docService.setEdgeDetectionState({
            imageData: samplePng,
            pageIndex: 2
        });

        fixture = TestBed.createComponent(EdgeAdjustComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();

        expect(component.pageIndex).toBe(2);
        expect(component.pageTitle).toBe('Crop Page 3');
    });

    it('should add current page and prepare for next photo when addPage is called', async () => {
        docService.setEdgeDetectionState({
            imageData: samplePng,
            sessionPages: [],
            isMultiScan: true
        });

        fixture = TestBed.createComponent(EdgeAdjustComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();

        spyOn(docService, 'cropAndTransform').and.returnValue(Promise.resolve(samplePng));

        await component.addPage();
        expect(component.sessionPages.length).toBe(1);
    });

    it('should confirm multi-page session and navigate to editor with all session pages', async () => {
        docService.setEdgeDetectionState({
            imageData: samplePng,
            sessionPages: [samplePng],
            isMultiScan: true,
            originalName: 'ScanSessionDoc'
        });

        fixture = TestBed.createComponent(EdgeAdjustComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();

        spyOn(docService, 'cropAndTransform').and.returnValue(Promise.resolve(samplePng));

        await component.confirm();

        const activeDoc = docService.getActiveDocument();
        expect(activeDoc).toBeTruthy();
        expect(activeDoc?.images?.length).toBe(2);
        expect(router.navigate).toHaveBeenCalledWith(['/editor'], { replaceUrl: true });
    });

    it('should confirm single page crop and update active document when pageIndex is set', async () => {
        docService.setActiveDocument({
            images: [samplePng, samplePng, samplePng],
            image: samplePng,
            originalName: 'ActiveDoc'
        });

        docService.setEdgeDetectionState({
            imageData: samplePng,
            pageIndex: 1
        });

        fixture = TestBed.createComponent(EdgeAdjustComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();

        const croppedResult = 'data:image/png;base64,cropped123';
        spyOn(docService, 'cropAndTransform').and.returnValue(Promise.resolve(croppedResult));

        await component.confirm();

        const activeDoc = docService.getActiveDocument();
        expect(activeDoc?.images?.[1]).toBe(croppedResult);
        expect(router.navigate).toHaveBeenCalledWith(['/editor'], { replaceUrl: true });
    });

    it('should discard crop changes and navigate to editor when cancel is called with pageIndex', async () => {
        docService.setActiveDocument({
            images: [samplePng, samplePng, samplePng],
            image: samplePng,
            originalName: 'ActiveDoc'
        });

        docService.setEdgeDetectionState({
            imageData: samplePng,
            pageIndex: 1
        });

        fixture = TestBed.createComponent(EdgeAdjustComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();

        await component.cancel();

        const activeDoc = docService.getActiveDocument();
        expect(activeDoc?.images?.[1]).toBe(samplePng);
        expect(docService.getEdgeDetectionState()).toBeNull();
        expect(router.navigate).toHaveBeenCalledWith(['/editor'], { replaceUrl: true });
    });
});
