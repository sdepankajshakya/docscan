import { Component, ViewChild, ElementRef, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonButton, IonIcon, IonSpinner, ActionSheetController } from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { arrowBackOutline, checkmarkOutline, downloadOutline, imageOutline, documentOutline, chevronBackOutline, chevronForwardOutline } from 'ionicons/icons';
import { DocumentProcessingService } from '../../services/doc-processing.service';

@Component({
    selector: 'app-doc-editor',
    templateUrl: './doc-editor.component.html',
    styleUrls: ['./doc-editor.component.scss'],
    standalone: true,
    imports: [CommonModule, IonButton, IonIcon, IonSpinner]
})
export class DocEditorComponent implements AfterViewInit {

    @ViewChild('canvas', { static: false })
    canvasRef!: ElementRef<HTMLCanvasElement>;

    public activeFilter: 'original' | 'grayscale' | 'adaptive-threshold' | 'high-contrast' | 'invert' | 'sepia' | 'brightness' | 'vibrant' | 'print-bw' = 'original';
    public loading = false;
    public currentPage = 0;
    public totalPages = 0;
    public allPreviewData: string[] = []; // FAST 1000px images for UI
    private allFullResData: string[] = []; // HIGH-RES 2500px images for Save

    private originalImageData?: ImageData;
    // Original inputs are now local state from service
    private image!: string;
    private images?: string[];
    private originalName?: string;

    private docService = inject(DocumentProcessingService);
    private actionSheetCtrl = inject(ActionSheetController);
    private router = inject(Router);

    constructor() {
        addIcons({ arrowBackOutline, checkmarkOutline, downloadOutline, imageOutline, documentOutline, chevronBackOutline, chevronForwardOutline });
    }

    ngAfterViewInit() {
        // Get active document from service
        const activeDoc = this.docService.getActiveDocument();
        if (!activeDoc) {
            console.error('No active document found');
            this.cancel();
            return;
        }

        this.image = activeDoc.image;
        this.images = activeDoc.images;
        this.originalName = activeDoc.originalName;

        this.loadImage();
    }

    private async loadImage() {
        this.loading = true;

        const rawImages = (this.images && this.images.length > 0) ? this.images : [this.image];
        this.totalPages = rawImages.length;
        this.allFullResData = rawImages;
        this.allPreviewData = [];

        // Generate fast previews (1000px)
        const tempCanvas = document.createElement('canvas');
        for (const imgData of rawImages) {
            await this.docService.loadImageToCanvas(tempCanvas, imgData, 1000);
            this.allPreviewData.push(tempCanvas.toDataURL('image/jpeg', 0.85));
        }

        this.currentPage = 0;
        await this.loadCurrentPage();
        this.loading = false;
    }

    private async loadCurrentPage() {
        if (!this.canvasRef || !this.allPreviewData[this.currentPage]) return;

        const result = await this.docService.loadImageToCanvas(
            this.canvasRef.nativeElement,
            this.allPreviewData[this.currentPage],
            1000 // UI stays fast
        );
        this.originalImageData = result.original;

        // Re-apply current filter
        if (this.activeFilter !== 'original') {
            this.applyFilter(this.activeFilter);
        }
    }

    public nextPage() {
        if (this.currentPage < this.totalPages - 1) {
            this.currentPage++;
            this.loadCurrentPage();
        }
    }

    public prevPage() {
        if (this.currentPage > 0) {
            this.currentPage--;
            this.loadCurrentPage();
        }
    }

    public applyFilter(filter: 'original' | 'grayscale' | 'adaptive-threshold' | 'high-contrast' | 'invert' | 'sepia' | 'brightness' | 'vibrant' | 'print-bw') {
        this.activeFilter = filter;
        if (!this.canvasRef || !this.originalImageData) return;

        requestAnimationFrame(() => {
            this.docService.applyFilter(
                this.canvasRef.nativeElement,
                filter,
                this.originalImageData!
            );
        });
    }

    cancel() {
        this.docService.clearActiveDocument();
        this.router.navigate(['/home'], { replaceUrl: true });
    }



    async save() {
        if (!this.images && !this.image || !this.canvasRef) return;

        this.loading = true;
        const allProcessedImages: string[] = [];

        // Process all pages with current filter USING FULL RESOLUTION (2500px)
        for (let i = 0; i < this.allFullResData.length; i++) {
            const tempCanvas = document.createElement('canvas');
            const result = await this.docService.loadImageToCanvas(tempCanvas, this.allFullResData[i], 2500);

            if (this.activeFilter !== 'original') {
                this.docService.applyFilter(tempCanvas, this.activeFilter, result.original);
            }

            allProcessedImages.push(tempCanvas.toDataURL('image/jpeg', 0.95)); // High fidelity for storage
        }

        this.loading = false;

        const canvas = this.canvasRef.nativeElement;
        const fullImage = allProcessedImages[0];
        const thumbnail = canvas.toDataURL('image/jpeg', 0.4); // Lower quality for thumbnails

        // Check if we are editing an existing document
        // Check if we are editing an existing document
        const activeDoc = this.docService.getActiveDocument();
        if (activeDoc && activeDoc.originalDoc) {
            let finalImageOrPdf = allProcessedImages[0];

            // If original was PDF, we must save back as PDF with all pages
            if (activeDoc.originalDoc.type === 'pdf') {
                const pdfBlob = await this.docService.exportAsPDF(allProcessedImages, activeDoc.originalDoc.name);
                finalImageOrPdf = await this.blobToBase64(pdfBlob);
            }

            await this.docService.updateDocument(activeDoc.originalDoc, finalImageOrPdf, thumbnail);
        } else {
            // New document
            const now = new Date();
            let name = this.originalName;
            if (!name) {
                name = `Scan_${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
            }

            // Auto-detect format: if multiple pages, save as PDF
            const format = allProcessedImages.length > 1 ? 'pdf' : 'image';

            await this.docService.saveProcessedDocument(
                allProcessedImages,
                name,
                format,
                thumbnail
            );
        }

        this.docService.clearActiveDocument();
        this.router.navigate(['/home'], { replaceUrl: true });
    }
    private blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
}
