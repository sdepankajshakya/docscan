import { Component, ViewChild, ElementRef, OnInit, AfterViewInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonButton, IonIcon, IonSpinner, ActionSheetController, AlertController, Platform, LoadingController, ViewWillEnter } from '@ionic/angular/standalone';
import { Router, NavigationEnd } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { addIcons } from 'ionicons';
import {
    arrowBackOutline,
    checkmarkOutline,
    downloadOutline,
    imageOutline,
    documentOutline,
    chevronBackOutline,
    chevronForwardOutline,
    trashOutline,
    cropOutline,
    addOutline,
    addCircleOutline,
    cameraOutline,
    imagesOutline,
    checkmarkDoneOutline
} from 'ionicons/icons';
import { DocumentProcessingService, FilterType, ScannedDocument, releaseCanvas } from '../../services/doc-processing.service';
import { DeviceCapabilityService } from '../../services/device-capability.service';
import { Filesystem, Directory } from '@capacitor/filesystem';

@Component({
    selector: 'app-doc-editor',
    templateUrl: './doc-editor.component.html',
    styleUrls: ['./doc-editor.component.scss'],
    standalone: true,
    imports: [CommonModule, IonButton, IonIcon, IonSpinner]
})
export class DocEditorComponent implements OnInit, AfterViewInit, ViewWillEnter, OnDestroy {

    @ViewChild('canvas', { static: false })
    canvasRef!: ElementRef<HTMLCanvasElement>;

    @ViewChild('addPageInput', { static: false })
    addPageInput!: ElementRef<HTMLInputElement>;

    public readonly placeholderPixel = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="130" fill="%23222"><rect width="100%" height="100%" rx="6"/></svg>';

    public activeFilter: FilterType = 'original';
    public loading = false;
    public loadingMessage = 'Loading document...';
    public canCancel = false;
    private exportAbortController: AbortController | null = null;

    public currentPage = 0;
    public totalPages = 0;
    public allPreviewData: string[] = []; // Lightweight thumbnails for UI strip
    private allFullResData: string[] = []; // High-res images / file paths
    public pageFilters: FilterType[] = []; // Individual filter for each page

    public draggedIndex: number | null = null;
    public dragOverIndex: number | null = null;
    private touchStartIndex: number | null = null;
    private touchTargetIndex: number | null = null;
    private touchMoved = false;

    private originalImageData?: ImageData;
    private originalName?: string;
    private originalDoc?: ScannedDocument;
    private routerSub?: Subscription;

    private docService = inject(DocumentProcessingService);
    public deviceCapabilityService = inject(DeviceCapabilityService);
    private actionSheetCtrl = inject(ActionSheetController);
    private alertCtrl = inject(AlertController);
    private loadingCtrl = inject(LoadingController);
    private platform = inject(Platform);
    private router = inject(Router);
    private cdr = inject(ChangeDetectorRef);

    constructor() {
        addIcons({
            arrowBackOutline,
            checkmarkOutline,
            downloadOutline,
            imageOutline,
            documentOutline,
            chevronBackOutline,
            chevronForwardOutline,
            trashOutline,
            cropOutline,
            addOutline,
            addCircleOutline,
            cameraOutline,
            imagesOutline,
            checkmarkDoneOutline
        });
    }

    ngOnInit() {
        this.initOrUpdateDocumentState();

        if (this.router?.events) {
            this.routerSub = this.router.events.pipe(
                filter((e): e is NavigationEnd => e instanceof NavigationEnd)
            ).subscribe((e: NavigationEnd) => {
                const url = e.urlAfterRedirects || e.url;
                if ((url === '/editor' || url.startsWith('/editor')) && this.canvasRef && this.allPreviewData.length > 0) {
                    this.refreshFromActiveDocument();
                }
            });
        }
    }

    ngOnDestroy() {
        if (this.exportAbortController) {
            this.exportAbortController.abort();
        }
        if (this.routerSub) {
            this.routerSub.unsubscribe();
        }
        if (this.canvasRef?.nativeElement) {
            releaseCanvas(this.canvasRef.nativeElement);
        }
        this.originalImageData = undefined;
        this.docService.closePdfSession();
    }

    async ionViewWillEnter() {
        await this.refreshFromActiveDocument();
    }

    ngAfterViewInit() {
        const activeDoc = this.docService.getActiveDocument();
        if (!activeDoc) {
            console.error('No active document found');
            this.cancel();
            return;
        }

        this.loadImage();
        this.cdr.detectChanges();
    }

    public async getPageDataUrl(index: number): Promise<string> {
        const item = this.allFullResData[index];
        if (!item) return '';
        if (item.startsWith('data:')) return item;
        return await this.docService.resolvePageDataUrl(item);
    }

    private isGeneratingThumbnails = false;

    private async loadImage() {
        this.loading = true;
        this.loadingMessage = 'Loading document...';

        const config = this.deviceCapabilityService.getAdaptiveConfig();

        if (this.totalPages <= 25) {
            // For smaller documents, generate all thumbnails smoothly
            this.loadingMessage = 'Generating previews...';
            const previews: string[] = [];
            for (let i = 0; i < this.allFullResData.length; i++) {
                const thumb = await this.docService.createThumbnail(
                    this.allFullResData[i],
                    config.thumbnailResolution,
                    config.thumbnailQuality
                );
                previews.push(thumb);
                if (i % config.thumbnailBatchSize === 0 && i > 0 && config.thumbnailYieldMs > 0) {
                    await new Promise(r => setTimeout(r, config.thumbnailYieldMs));
                }
            }
            this.allPreviewData = previews;
        } else {
            // For large documents (e.g. 50 to 1,000+ pages), only generate the active window
            this.allPreviewData = new Array(this.totalPages).fill('');
            await this.ensureThumbnailsForWindow(this.currentPage);
        }

        await this.loadCurrentPage();
        this.loading = false;
        this.cdr.detectChanges();

        if (this.totalPages > 25) {
            this.scheduleBackgroundThumbnails();
        }
    }

    public async ensureThumbnailsForWindow(centerIndex: number): Promise<void> {
        const config = this.deviceCapabilityService.getAdaptiveConfig();
        const windowRadius = config.tier === 'low' ? 6 : (config.tier === 'mid' ? 10 : 15);
        const start = Math.max(0, centerIndex - windowRadius);
        const end = Math.min(this.totalPages - 1, centerIndex + windowRadius);

        // Memory pressure check: if heap is critical, evict thumbnails far from centerIndex
        if (this.deviceCapabilityService.isMemoryPressureCritical() && this.totalPages > 30) {
            const evictDistance = windowRadius * 2;
            for (let i = 0; i < this.totalPages; i++) {
                if (Math.abs(i - centerIndex) > evictDistance && this.allPreviewData[i]) {
                    this.allPreviewData[i] = '';
                }
            }
        }

        // Generate current page thumbnail first if missing
        if (!this.allPreviewData[centerIndex] && this.allFullResData[centerIndex]) {
            this.allPreviewData[centerIndex] = await this.docService.createThumbnail(
                this.allFullResData[centerIndex],
                config.thumbnailResolution,
                config.thumbnailQuality
            );
            this.cdr.detectChanges();
        }

        // Then generate missing thumbnails in the window
        for (let i = start; i <= end; i++) {
            if (!this.allPreviewData[i] && this.allFullResData[i]) {
                this.allPreviewData[i] = await this.docService.createThumbnail(
                    this.allFullResData[i],
                    config.thumbnailResolution,
                    config.thumbnailQuality
                );
                if (i % config.thumbnailBatchSize === 0) {
                    this.cdr.detectChanges();
                    if (config.thumbnailYieldMs > 0) {
                        await new Promise(r => setTimeout(r, config.thumbnailYieldMs));
                    }
                }
            }
        }
        this.cdr.detectChanges();
    }

    private scheduleBackgroundThumbnails() {
        if (this.isGeneratingThumbnails) return;
        this.isGeneratingThumbnails = true;

        setTimeout(async () => {
            const config = this.deviceCapabilityService.getAdaptiveConfig();
            for (let i = 0; i < this.totalPages; i++) {
                // If destroyed or navigated away
                if (!this.canvasRef) break;

                // Stop if memory pressure is critical
                if (this.deviceCapabilityService.isMemoryPressureCritical()) {
                    break;
                }

                if (!this.allPreviewData[i] && this.allFullResData[i]) {
                    this.allPreviewData[i] = await this.docService.createThumbnail(
                        this.allFullResData[i],
                        config.thumbnailResolution,
                        config.thumbnailQuality
                    );
                    if (i % config.thumbnailBatchSize === 0) {
                        this.cdr.detectChanges();
                        await new Promise(r => setTimeout(r, Math.max(16, config.thumbnailYieldMs)));
                    }
                }
            }
            this.isGeneratingThumbnails = false;
        }, 300);
    }

    private initOrUpdateDocumentState() {
        const activeDoc = this.docService.getActiveDocument();
        if (!activeDoc) {
            return;
        }

        this.originalName = activeDoc.originalName;
        this.originalDoc = activeDoc.originalDoc;

        const rawImages = (activeDoc.images && activeDoc.images.length > 0)
            ? [...activeDoc.images]
            : (activeDoc.image ? [activeDoc.image] : []);

        this.allFullResData = rawImages;
        this.totalPages = rawImages.length;

        if (activeDoc.pageFilters && activeDoc.pageFilters.length === this.totalPages) {
            this.pageFilters = [...activeDoc.pageFilters];
        } else if (this.pageFilters.length !== this.totalPages) {
            this.pageFilters = new Array(this.totalPages).fill('original');
        }

        if (activeDoc.currentPage !== undefined && activeDoc.currentPage < this.totalPages) {
            this.currentPage = activeDoc.currentPage;
        } else if (this.currentPage >= this.totalPages) {
            this.currentPage = 0;
        }

        this.activeFilter = this.pageFilters[this.currentPage] || 'original';
    }

    public async refreshFromActiveDocument(forceFull = false) {
        const activeDoc = this.docService.getActiveDocument();
        if (!activeDoc) {
            return;
        }

        this.originalName = activeDoc.originalName;
        this.originalDoc = activeDoc.originalDoc;

        const rawImages = (activeDoc.images && activeDoc.images.length > 0)
            ? [...activeDoc.images]
            : (activeDoc.image ? [activeDoc.image] : []);

        if (rawImages.length === 0) {
            return;
        }

        // Check if full-res images or count changed
        let hasChanges = forceFull || (rawImages.length !== this.allFullResData.length) || (this.allPreviewData.length !== rawImages.length) || (rawImages.length <= 25 && this.allPreviewData.some(p => !p));
        if (!hasChanges) {
            for (let i = 0; i < rawImages.length; i++) {
                if (rawImages[i] !== this.allFullResData[i]) {
                    hasChanges = true;
                    break;
                }
            }
        }

        // If no image changes, check if currentPage changed in activeDoc
        if (!hasChanges) {
            if (activeDoc.currentPage !== undefined && activeDoc.currentPage < rawImages.length && activeDoc.currentPage !== this.currentPage) {
                this.currentPage = activeDoc.currentPage;
                this.activeFilter = this.pageFilters[this.currentPage] || 'original';
                await this.loadCurrentPage();
                this.cdr.detectChanges();
            }
            return;
        }

        // Sync page filters
        if (activeDoc.pageFilters && activeDoc.pageFilters.length === rawImages.length) {
            this.pageFilters = [...activeDoc.pageFilters];
        } else if (this.pageFilters.length !== rawImages.length) {
            const oldFilters = [...this.pageFilters];
            this.pageFilters = new Array(rawImages.length).fill('original');
            for (let i = 0; i < Math.min(oldFilters.length, rawImages.length); i++) {
                this.pageFilters[i] = oldFilters[i];
            }
        }

        // Update current page
        if (activeDoc.currentPage !== undefined && activeDoc.currentPage < rawImages.length) {
            this.currentPage = activeDoc.currentPage;
        } else if (this.currentPage >= rawImages.length) {
            this.currentPage = Math.max(0, rawImages.length - 1);
        }

        this.totalPages = rawImages.length;
        this.activeFilter = this.pageFilters[this.currentPage] || 'original';

        // Update previews: only generate thumbnail for pages that are new or modified
        const updatedPreviews: string[] = [];

        this.loading = true;
        this.loadingMessage = forceFull ? 'Generating previews...' : 'Updating preview...';

        for (let i = 0; i < rawImages.length; i++) {
            if (!forceFull && i < this.allPreviewData.length && i < this.allFullResData.length && rawImages[i] === this.allFullResData[i] && this.allPreviewData[i]) {
                // Image untouched, preserve existing preview
                updatedPreviews.push(this.allPreviewData[i]);
            } else {
                // New or modified (e.g. cropped) page: generate fresh lightweight thumbnail
                const thumb = await this.docService.createThumbnail(rawImages[i], 200, 0.70);
                updatedPreviews.push(thumb);
                if (i % 3 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }
        }

        this.allFullResData = rawImages;
        this.allPreviewData = updatedPreviews;

        if (this.canvasRef) {
            await this.loadCurrentPage();
        }

        this.loading = false;
        this.syncActiveDocument();
        this.cdr.detectChanges();
    }

    private async loadCurrentPage() {
        if (!this.canvasRef || this.currentPage >= this.allFullResData.length) return;

        // Release previous ImageData buffer to keep memory bounded
        this.originalImageData = undefined;

        const pageData = await this.getPageDataUrl(this.currentPage);
        if (!pageData) return;

        const config = this.deviceCapabilityService.getAdaptiveConfig();
        const maxResolution = config.previewResolution;

        const result = await this.docService.loadImageToCanvas(
            this.canvasRef.nativeElement,
            pageData,
            maxResolution
        );
        this.originalImageData = result.original;

        // Sync active filter with current page's filter
        this.activeFilter = this.pageFilters[this.currentPage] || 'original';

        // Apply current page's filter
        if (this.activeFilter !== 'original') {
            this.docService.applyFilter(
                this.canvasRef.nativeElement,
                this.activeFilter,
                this.originalImageData
            );
        }
    }

    public async selectPage(index: number) {
        if (index >= 0 && index < this.totalPages && index !== this.currentPage) {
            this.currentPage = index;
            this.activeFilter = this.pageFilters[this.currentPage] || 'original';
            this.syncActiveDocument();
            await this.loadCurrentPage();
            if (this.totalPages > 25) {
                this.ensureThumbnailsForWindow(this.currentPage);
            }
        }
    }

    public async nextPage() {
        if (this.currentPage < this.totalPages - 1) {
            this.currentPage++;
            this.activeFilter = this.pageFilters[this.currentPage] || 'original';
            this.syncActiveDocument();
            await this.loadCurrentPage();
            if (this.totalPages > 25) {
                this.ensureThumbnailsForWindow(this.currentPage);
            }
        }
    }

    public async prevPage() {
        if (this.currentPage > 0) {
            this.currentPage--;
            this.activeFilter = this.pageFilters[this.currentPage] || 'original';
            this.syncActiveDocument();
            await this.loadCurrentPage();
            if (this.totalPages > 25) {
                this.ensureThumbnailsForWindow(this.currentPage);
            }
        }
    }

    public selectFilter(filter: FilterType) {
        this.activeFilter = filter;
        this.pageFilters = new Array(this.totalPages).fill(filter);
        this.syncActiveDocument();

        if (!this.canvasRef || !this.originalImageData) return;

        requestAnimationFrame(() => {
            this.docService.applyFilter(
                this.canvasRef.nativeElement,
                filter,
                this.originalImageData!
            );
        });
    }

    public applyFilterToAll() {
        this.pageFilters = new Array(this.totalPages).fill(this.activeFilter);
        this.syncActiveDocument();
    }

    public reorderPage(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= this.totalPages || toIndex >= this.totalPages) {
            return;
        }

        const isCurrentPage = this.currentPage === fromIndex;

        const [movedFull] = this.allFullResData.splice(fromIndex, 1);
        this.allFullResData.splice(toIndex, 0, movedFull);

        const [movedPrev] = this.allPreviewData.splice(fromIndex, 1);
        this.allPreviewData.splice(toIndex, 0, movedPrev);

        const [movedFilter] = this.pageFilters.splice(fromIndex, 1);
        this.pageFilters.splice(toIndex, 0, movedFilter);

        if (isCurrentPage) {
            this.currentPage = toIndex;
        } else if (fromIndex < this.currentPage && toIndex >= this.currentPage) {
            this.currentPage--;
        } else if (fromIndex > this.currentPage && toIndex <= this.currentPage) {
            this.currentPage++;
        }

        this.activeFilter = this.pageFilters[this.currentPage] || 'original';
        this.syncActiveDocument();
        this.loadCurrentPage();
        this.cdr.detectChanges();
    }

    public onDragStart(event: DragEvent, index: number) {
        this.draggedIndex = index;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', index.toString());
        }
    }

    public onDragOver(event: DragEvent, index: number) {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        this.dragOverIndex = index;
    }

    public onDragEnter(event: DragEvent, index: number) {
        event.preventDefault();
        this.dragOverIndex = index;
    }

    public onDragLeave(_event: DragEvent, index: number) {
        if (this.dragOverIndex === index) {
            this.dragOverIndex = null;
        }
    }

    public onDrop(event: DragEvent, toIndex: number) {
        event.preventDefault();
        const fromIndex = this.draggedIndex !== null ? this.draggedIndex : (event.dataTransfer ? parseInt(event.dataTransfer.getData('text/plain'), 10) : null);
        if (fromIndex !== null && !isNaN(fromIndex) && fromIndex !== toIndex) {
            this.reorderPage(fromIndex, toIndex);
        }
        this.draggedIndex = null;
        this.dragOverIndex = null;
    }

    public onDragEnd() {
        this.draggedIndex = null;
        this.dragOverIndex = null;
    }

    public onTouchStart(_event: TouchEvent, index: number) {
        this.touchStartIndex = index;
        this.touchTargetIndex = index;
        this.touchMoved = false;
    }

    public onTouchMove(event: TouchEvent) {
        if (this.touchStartIndex === null) return;
        this.touchMoved = true;
        this.draggedIndex = this.touchStartIndex;

        const touch = event.touches[0];
        const elem = document.elementFromPoint(touch.clientX, touch.clientY);
        if (elem) {
            const card = elem.closest('.thumb-card') as HTMLElement;
            if (card && card.dataset['index'] !== undefined) {
                const targetIdx = parseInt(card.dataset['index'], 10);
                if (!isNaN(targetIdx)) {
                    this.touchTargetIndex = targetIdx;
                    this.dragOverIndex = targetIdx;
                }
            }
        }
    }

    public onTouchEnd() {
        if (this.touchMoved && this.touchStartIndex !== null && this.touchTargetIndex !== null && this.touchStartIndex !== this.touchTargetIndex) {
            this.reorderPage(this.touchStartIndex, this.touchTargetIndex);
        }
        this.touchStartIndex = null;
        this.touchTargetIndex = null;
        this.touchMoved = false;
        this.draggedIndex = null;
        this.dragOverIndex = null;
    }

    public movePageLeft() {
        if (this.currentPage > 0) {
            this.reorderPage(this.currentPage, this.currentPage - 1);
        }
    }

    public movePageRight() {
        if (this.currentPage < this.totalPages - 1) {
            this.reorderPage(this.currentPage, this.currentPage + 1);
        }
    }

    public async deleteCurrentPage() {
        if (this.totalPages <= 1) {
            const alert = await this.alertCtrl.create({
                header: 'Delete Page?',
                message: 'This is the only page in the document. Deleting it will discard this document.',
                buttons: [
                    { text: 'Cancel', role: 'cancel' },
                    {
                        text: 'Discard',
                        role: 'destructive',
                        handler: () => {
                            this.cancel();
                        }
                    }
                ]
            });
            await alert.present();
            return;
        }

        const alert = await this.alertCtrl.create({
            header: 'Delete Page?',
            message: `Are you sure you want to remove Page ${this.currentPage + 1}?`,
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Delete',
                    role: 'destructive',
                    handler: async () => {
                        this.allFullResData.splice(this.currentPage, 1);
                        this.allPreviewData.splice(this.currentPage, 1);
                        this.pageFilters.splice(this.currentPage, 1);

                        this.totalPages = this.allFullResData.length;
                        if (this.currentPage >= this.totalPages) {
                            this.currentPage = this.totalPages - 1;
                        }

                        this.syncActiveDocument();
                        await this.loadCurrentPage();
                    }
                }
            ]
        });
        await alert.present();
    }

    public async cropCurrentPage() {
        if (!this.allFullResData[this.currentPage]) return;

        this.syncActiveDocument();

        const loading = await this.loadingCtrlCreate('Detecting document edges...');
        await loading.present();

        const currentImage = await this.getPageDataUrl(this.currentPage);
        const corners = await this.docService.detectDocumentEdges(currentImage);
        await loading.dismiss();

        this.docService.setEdgeDetectionState({
            imageData: currentImage,
            detectedCorners: corners || undefined,
            pageIndex: this.currentPage,
            originalName: this.originalName
        });

        this.router.navigate(['/edge-adjust']);
    }

    public async addPage() {
        const actionSheet = await this.actionSheetCtrl.create({
            header: 'Add Page',
            buttons: [
                {
                    text: 'Scan with Camera',
                    icon: 'camera-outline',
                    handler: () => {
                        this.addPageFromCamera();
                    }
                },
                {
                    text: 'Import from Gallery / Files',
                    icon: 'images-outline',
                    handler: () => {
                        this.addPageFromGallery();
                    }
                },
                {
                    text: 'Cancel',
                    role: 'cancel'
                }
            ]
        });
        await actionSheet.present();
    }

    private async addPageFromCamera() {
        if (this.platform.is('hybrid')) {
            try {
                const photo = await this.docService.takePhoto();
                if (photo.dataUrl) {
                    this.syncActiveDocument();

                    const loading = await this.loadingCtrlCreate('Detecting edges...');
                    await loading.present();
                    const corners = await this.docService.detectDocumentEdges(photo.dataUrl);
                    await loading.dismiss();

                    this.docService.setEdgeDetectionState({
                        imageData: photo.dataUrl,
                        detectedCorners: corners || undefined,
                        returnToEditor: true,
                        originalName: this.originalName
                    });

                    this.router.navigate(['/edge-adjust']);
                }
            } catch (e) {
                console.log('User cancelled camera capture', e);
            }
        } else {
            this.addPageInput.nativeElement.click();
        }
    }

    private async addPageFromGallery() {
        if (this.platform.is('hybrid')) {
            try {
                const result = await this.docService.pickImages();
                if (result && result.photos && result.photos.length > 0) {
                    const loading = await this.loadingCtrlCreate(`Adding ${result.photos.length} image(s)...`);
                    await loading.present();

                    for (const photo of result.photos) {
                        const dataUrl = await this.docService.readGalleryPhotoAsDataUrl(photo);
                        await this.appendNewPage(dataUrl);
                    }

                    await loading.dismiss();
                    await this.loadCurrentPage();
                }
            } catch (e) {
                console.error('Error picking gallery images', e);
            }
        } else {
            this.addPageInput.nativeElement.click();
        }
    }

    public async onAddPageFilesSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        if (!input.files || input.files.length === 0) return;

        const files = Array.from(input.files);
        const imageFiles = files.filter(f => f.type.startsWith('image/'));

        if (imageFiles.length > 0) {
            const loading = await this.loadingCtrlCreate(`Adding ${imageFiles.length} page(s)...`);
            await loading.present();

            for (const file of imageFiles) {
                const dataUrl = await this.docService.fileToDataUrl(file);
                await this.appendNewPage(dataUrl);
            }

            await loading.dismiss();
            await this.loadCurrentPage();
        }

        input.value = '';
    }

    private async appendNewPage(imageData: string) {
        this.allFullResData.push(imageData);

        const thumb = await this.docService.createThumbnail(imageData, 200, 0.70);
        this.allPreviewData.push(thumb);

        this.pageFilters.push('original');
        this.totalPages = this.allFullResData.length;
        this.currentPage = this.totalPages - 1;

        this.syncActiveDocument();
    }

    private syncActiveDocument() {
        this.docService.setActiveDocument({
            images: this.allFullResData,
            image: this.allFullResData[0],
            originalName: this.originalName,
            originalDoc: this.originalDoc,
            pageFilters: this.pageFilters,
            currentPage: this.currentPage
        });
    }

    public cancelExport() {
        if (this.exportAbortController) {
            this.exportAbortController.abort();
        }
    }

    cancel() {
        if (this.exportAbortController) {
            this.exportAbortController.abort();
        }
        this.docService.cleanupTempFiles();
        this.docService.clearActiveDocument();
        this.router.navigate(['/home'], { replaceUrl: true });
    }

    async save() {
        if (!this.allFullResData.length || !this.canvasRef) return;

        this.loading = true;
        this.canCancel = true;
        this.loadingMessage = 'Processing document...';
        this.exportAbortController = new AbortController();

        const total = this.allFullResData.length;
        const processedPageRefs: string[] = [];

        try {
            // Process pages incrementally one-by-one to prevent heap spikes
            for (let i = 0; i < total; i++) {
                if (this.exportAbortController.signal.aborted) {
                    throw new DOMException('Export cancelled', 'AbortError');
                }

                const pct = Math.round(((i + 1) / total) * 100);
                this.loadingMessage = `Processing page ${i + 1} of ${total} (${pct}%)...`;
                this.cdr.detectChanges();

                const filter = this.pageFilters[i] || 'original';
                const rawData = await this.getPageDataUrl(i);

                // If no filter applied, preserve original data directly (zero re-encoding, zero memory bloat)
                if (filter === 'original') {
                    processedPageRefs.push(this.allFullResData[i]);
                } else {
                    // Apply filter at high resolution (2500px)
                    const tempCanvas = document.createElement('canvas');
                    try {
                        const result = await this.docService.loadImageToCanvas(tempCanvas, rawData, 2500);
                        this.docService.applyFilter(tempCanvas, filter, result.original);
                        const filteredJpg = tempCanvas.toDataURL('image/jpeg', 0.95);

                        // If multi-page, persist to temporary cache file to avoid accumulating gigabytes in RAM
                        if (total > 3) {
                            const tempFile = `temp_page_filt_${Date.now()}_${i}_${Math.floor(Math.random() * 10000)}.jpg`;
                            await Filesystem.writeFile({
                                path: tempFile,
                                data: filteredJpg,
                                directory: Directory.Cache
                            });
                            this.docService.registerTempFile(tempFile);
                            processedPageRefs.push(tempFile);
                        } else {
                            processedPageRefs.push(filteredJpg);
                        }
                    } finally {
                        releaseCanvas(tempCanvas);
                    }
                }

                await new Promise(r => setTimeout(r, 0));
            }

            this.loadingMessage = 'Saving document...';
            this.cdr.detectChanges();

            const canvas = this.canvasRef.nativeElement;
            const thumbnail = canvas.toDataURL('image/jpeg', 0.4);

            const activeDoc = this.docService.getActiveDocument();
            if (activeDoc && activeDoc.originalDoc) {
                let finalImageOrPdf = processedPageRefs[0];
                const isMultiPage = processedPageRefs.length > 1;
                const newType = (activeDoc.originalDoc.type === 'pdf' || isMultiPage) ? 'pdf' : 'image';

                if (newType === 'pdf') {
                    const pdfBlob = await this.docService.exportAsPDF(processedPageRefs, activeDoc.originalDoc.name, {
                        abortSignal: this.exportAbortController.signal
                    });
                    finalImageOrPdf = await this.blobToBase64(pdfBlob);
                } else {
                    finalImageOrPdf = await this.getPageDataUrl(0);
                }

                await this.docService.updateDocument(activeDoc.originalDoc, finalImageOrPdf, thumbnail, newType);
            } else {
                // New document
                const now = new Date();
                let name = this.originalName;
                if (!name) {
                    name = `Scan_${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
                }

                // If multiple pages, always save as PDF
                const format = processedPageRefs.length > 1 ? 'pdf' : 'image';

                await this.docService.saveProcessedDocument(
                    processedPageRefs,
                    name,
                    format,
                    thumbnail
                );
            }

            this.loading = false;
            this.canCancel = false;
            this.docService.clearActiveDocument();
            this.router.navigate(['/home'], { replaceUrl: true });
        } catch (e: any) {
            this.loading = false;
            this.canCancel = false;
            this.cdr.detectChanges();

            if (e?.name === 'AbortError') {
                console.log('Export cancelled by user');
            } else {
                const msg = e?.message || 'Failed to save document.';
                const alert = await this.alertCtrl.create({
                    header: 'Save Error',
                    message: msg,
                    buttons: ['OK']
                });
                await alert.present();
            }
        }
    }

    private blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    private async loadingCtrlCreate(message: string) {
        return await this.loadingCtrl.create({ message, spinner: 'crescent' });
    }
}
