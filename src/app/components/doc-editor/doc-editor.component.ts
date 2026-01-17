import { Component, ViewChild, ElementRef, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ActionSheetController } from '@ionic/angular';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { arrowBackOutline, checkmarkOutline, downloadOutline, imageOutline, documentOutline, chevronBackOutline, chevronForwardOutline } from 'ionicons/icons';
import { DocumentProcessingService } from '../../services/doc-processing.service';

@Component({
    selector: 'app-doc-editor',
    templateUrl: './doc-editor.component.html',
    styleUrls: ['./doc-editor.component.scss'],
    standalone: true,
    imports: [CommonModule, IonicModule]
})
export class DocEditorComponent implements AfterViewInit {

    @ViewChild('canvas', { static: false })
    canvasRef!: ElementRef<HTMLCanvasElement>;

    public activeFilter: 'original' | 'grayscale' | 'adaptive-threshold' | 'high-contrast' | 'invert' | 'sepia' | 'brightness' | 'vibrant' = 'original';
    public loading = false;
    public currentPage = 0;
    public totalPages = 0;
    public allImageData: string[] = [];

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

        if (this.images && this.images.length > 0) {
            // Multi-page mode - store all images and load first page
            this.allImageData = this.images;
            this.totalPages = this.images.length;
            this.currentPage = 0;
            await this.loadCurrentPage();
        } else if (this.image && this.canvasRef) {
            // Single image mode
            this.allImageData = [this.image];
            this.totalPages = 1;
            this.currentPage = 0;
            await this.loadCurrentPage();
        }

        this.loading = false;
    }

    private async loadCurrentPage() {
        if (!this.canvasRef || !this.allImageData[this.currentPage]) return;

        const result = await this.docService.loadImageToCanvas(
            this.canvasRef.nativeElement,
            this.allImageData[this.currentPage]
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

    public applyFilter(filter: 'original' | 'grayscale' | 'adaptive-threshold' | 'high-contrast' | 'invert' | 'sepia' | 'brightness' | 'vibrant') {
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
        if (!this.originalImageData || !this.canvasRef) return;

        this.loading = true;
        const allProcessedImages: string[] = [];

        // Process all pages with current filter
        for (let i = 0; i < this.allImageData.length; i++) {
            const tempCanvas = document.createElement('canvas');
            const result = await this.docService.loadImageToCanvas(tempCanvas, this.allImageData[i]);

            if (this.activeFilter !== 'original') {
                this.docService.applyFilter(tempCanvas, this.activeFilter, result.original);
            }

            allProcessedImages.push(tempCanvas.toDataURL('image/jpeg', 0.85)); // Optimized quality
        }

        this.loading = false;

        const canvas = this.canvasRef.nativeElement;
        const fullImage = allProcessedImages[0];
        const thumbnail = canvas.toDataURL('image/jpeg', 0.4); // Lower quality for thumbnails

        // Check if we are editing an existing document
        const activeDoc = this.docService.getActiveDocument();
        if (activeDoc && activeDoc.originalDoc) {
            await this.docService.updateDocument(activeDoc.originalDoc, fullImage, thumbnail);
        } else {
            // New document
            const now = new Date();
            let name = this.originalName;
            if (!name) {
                name = `Scan_${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
            }

            await this.docService.saveProcessedDocument(
                [fullImage],
                name,
                'image',
                thumbnail
            );
        }

        this.docService.clearActiveDocument();
        this.router.navigate(['/home'], { replaceUrl: true });
    }
}
