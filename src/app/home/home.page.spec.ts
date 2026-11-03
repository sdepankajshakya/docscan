import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HomePage } from './home.page';
import { DocumentProcessingService } from '../services/doc-processing.service';
import { provideRouter, Router } from '@angular/router';

describe('HomePage - Multi-page scanning & Gallery import', () => {
  let component: HomePage;
  let fixture: ComponentFixture<HomePage>;
  let docService: DocumentProcessingService;
  let router: Router;

  const samplePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [
        DocumentProcessingService,
        provideRouter([])
      ]
    }).compileComponents();

    docService = TestBed.inject(DocumentProcessingService);
    spyOn(docService, 'getProcessingState').and.returnValue(Promise.resolve(null));
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.returnValue(Promise.resolve(true));

    fixture = TestBed.createComponent(HomePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should handle multi-image file selection and navigate to editor', async () => {
    const file1 = new File(['img1'], 'photo1.jpg', { type: 'image/jpeg' });
    const file2 = new File(['img2'], 'photo2.jpg', { type: 'image/jpeg' });

    spyOn(docService, 'fileToDataUrl').and.returnValue(Promise.resolve(samplePng));

    const mockEvent = {
      target: {
        files: [file1, file2],
        value: ''
      }
    } as any;

    await component.handleFileSelect(mockEvent);

    const activeDoc = docService.getActiveDocument();
    expect(activeDoc).toBeTruthy();
    expect(activeDoc?.images?.length).toBe(2);
    expect(router.navigate).toHaveBeenCalledWith(['/editor']);
  });

  it('should handle single image file selection with detectAndCrop', async () => {
    const file1 = new File(['img1'], 'single.jpg', { type: 'image/jpeg' });

    spyOn(docService, 'fileToDataUrl').and.returnValue(Promise.resolve(samplePng));
    spyOn(component, 'detectAndCrop').and.returnValue(Promise.resolve());

    const mockEvent = {
      target: {
        files: [file1],
        value: ''
      }
    } as any;

    await component.handleFileSelect(mockEvent);

    expect(component.detectAndCrop).toHaveBeenCalledWith(
      samplePng,
      'single',
      jasmine.objectContaining({ sessionPages: [], isMultiScan: true })
    );
  });

  it('should import multiple images from gallery and navigate to editor', async () => {
    spyOn(docService, 'pickImages').and.returnValue(Promise.resolve({
      photos: [
        { format: 'jpeg', saved: false, webPath: 'blob:test1' },
        { format: 'jpeg', saved: false, webPath: 'blob:test2' }
      ]
    }));
    spyOn(docService, 'readGalleryPhotoAsDataUrl').and.returnValue(Promise.resolve(samplePng));

    await component.pickImagesFromGallery();

    const activeDoc = docService.getActiveDocument();
    expect(activeDoc).toBeTruthy();
    expect(activeDoc?.images?.length).toBe(2);
    expect(router.navigate).toHaveBeenCalledWith(['/editor']);
  });
});
