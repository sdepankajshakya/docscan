import { Component, ViewChild, ElementRef, OnInit, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonButton, IonIcon, LoadingController, AlertController, Platform, ViewWillEnter } from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { closeOutline, checkmarkOutline, cameraOutline, addCircleOutline, refreshOutline } from 'ionicons/icons';
import { DocumentProcessingService } from '../../services/doc-processing.service';

@Component({
    selector: 'app-edge-adjust',
    templateUrl: './edge-adjust.component.html',
    styleUrls: ['./edge-adjust.component.scss'],
    standalone: true,
    imports: [CommonModule, IonButton, IonIcon]
})
export class EdgeAdjustComponent implements OnInit, AfterViewInit, ViewWillEnter {

    @ViewChild('canvas', { static: false })
    canvasRef!: ElementRef<HTMLCanvasElement>;

    @ViewChild('pageFileInput', { static: false })
    pageFileInput!: ElementRef<HTMLInputElement>;

    public corners: Array<{ x: number; y: number }> = [];
    public draggingIndex: number | null = null;
    public imageLoaded = false;
    public sessionPages: string[] = [];
    public pageIndex?: number;
    public isMultiScan = false;
    public returnToEditor = false;
    public pageTitle = 'Adjust Corners';
    public processing = false;

    private img!: HTMLImageElement;
    private scale = 1;
    private imageData!: string;
    public detectedCorners?: Array<{ x: number; y: number }>;
    private originalName?: string;

    private docService = inject(DocumentProcessingService);
    private router = inject(Router);
    private loadingCtrl = inject(LoadingController);
    private alertCtrl = inject(AlertController);
    private platform = inject(Platform);

    constructor() {
        addIcons({ closeOutline, checkmarkOutline, cameraOutline, addCircleOutline, refreshOutline });
    }

    ngOnInit() {
        this.loadStateAndInit();
    }

    ionViewWillEnter() {
        this.loadStateAndInit();
        if (this.canvasRef && this.imageData) {
            this.loadImage();
        }
    }

    ngAfterViewInit() {
        // Load state from service
        const state = this.docService.getEdgeDetectionState();
        if (!state || !state.imageData) {
            console.error('No image data found for edge adjustment');
            this.cancel();
            return;
        }

        this.loadStateAndInit();

        // Small delay to ensure view is ready
        setTimeout(() => {
            this.loadImage();
        }, 100);
    }

    private loadStateAndInit() {
        const state = this.docService.getEdgeDetectionState();
        if (state && state.imageData) {
            this.imageData = state.imageData;
            this.detectedCorners = state.detectedCorners;
            this.originalName = state.originalName;
            this.sessionPages = state.sessionPages ? [...state.sessionPages] : [];
            this.pageIndex = state.pageIndex;
            this.isMultiScan = !!state.isMultiScan;
            this.returnToEditor = !!state.returnToEditor;
            this.updateTitle();
        }
    }

    private updateTitle() {
        if (this.pageIndex !== undefined) {
            this.pageTitle = `Crop Page ${this.pageIndex + 1}`;
        } else if (this.sessionPages.length > 0) {
            this.pageTitle = `Page ${this.sessionPages.length + 1} (${this.sessionPages.length} scanned)`;
        } else if (this.isMultiScan) {
            this.pageTitle = 'Scan Document - Page 1';
        } else {
            this.pageTitle = 'Adjust Corners';
        }
    }

    private loadImage() {
        if (!this.canvasRef || !this.imageData) {
            return;
        }

        this.img = new Image();
        this.img.crossOrigin = 'anonymous';

        this.img.onload = () => {
            const canvas = this.canvasRef.nativeElement;
            const cornerMarkerRadius = 20; // Account for the corner markers

            // Calculate scale to fit viewport with margin for corners and bottom actions
            const maxWidth = window.innerWidth - 80;
            const maxHeight = window.innerHeight - 360;

            const scaleX = maxWidth / this.img.width;
            const scaleY = maxHeight / this.img.height;
            this.scale = Math.min(scaleX, scaleY, 0.85);

            // Set canvas to scaled size with padding for corner markers
            const displayWidth = this.img.width * this.scale + cornerMarkerRadius * 2;
            const displayHeight = this.img.height * this.scale + cornerMarkerRadius * 2;

            canvas.width = displayWidth;
            canvas.height = displayHeight;

            // Store padding offset for drawing
            const padding = cornerMarkerRadius;

            // Set default corners or use detected ones
            if (this.detectedCorners && this.detectedCorners.length === 4) {
                // Scale detected corners to canvas size and add padding offset
                this.corners = this.detectedCorners.map(c => ({
                    x: c.x * this.scale + padding,
                    y: c.y * this.scale + padding
                }));
            } else {
                // Default corners (full canvas with padding)
                const defaultPadding = 30;
                this.corners = [
                    { x: padding + defaultPadding, y: padding + defaultPadding },
                    { x: displayWidth - padding - defaultPadding, y: padding + defaultPadding },
                    { x: displayWidth - padding - defaultPadding, y: displayHeight - padding - defaultPadding },
                    { x: padding + defaultPadding, y: displayHeight - padding - defaultPadding }
                ];
            }

            this.imageLoaded = true;
            this.drawCanvas();
        };

        this.img.onerror = (error) => {
            console.error('Failed to load image:', error);
            this.cancel();
        };

        this.img.src = this.imageData;
    }

    private drawCanvas() {
        const canvas = this.canvasRef.nativeElement;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        const cornerMarkerRadius = 20;
        const padding = cornerMarkerRadius;

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw padding background (dark)
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw image with padding offset
        const scaledWidth = this.img.width * this.scale;
        const scaledHeight = this.img.height * this.scale;
        ctx.drawImage(this.img, padding, padding, scaledWidth, scaledHeight);

        // Draw semi-transparent overlay over entire image (lighter for better visibility)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(padding, padding, scaledWidth, scaledHeight);

        // Clear the overlay inside the document area
        if (this.corners.length === 4) {
            ctx.save();
            ctx.globalCompositeOperation = 'destination-out';
            ctx.beginPath();
            ctx.moveTo(this.corners[0].x, this.corners[0].y);
            ctx.lineTo(this.corners[1].x, this.corners[1].y);
            ctx.lineTo(this.corners[2].x, this.corners[2].y);
            ctx.lineTo(this.corners[3].x, this.corners[3].y);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            // Draw border around document
            ctx.strokeStyle = '#4285F4';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(this.corners[0].x, this.corners[0].y);
            ctx.lineTo(this.corners[1].x, this.corners[1].y);
            ctx.lineTo(this.corners[2].x, this.corners[2].y);
            ctx.lineTo(this.corners[3].x, this.corners[3].y);
            ctx.closePath();
            ctx.stroke();

            // Draw smaller corner markers
            this.corners.forEach((corner) => {
                // Outer circle (white)
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.arc(corner.x, corner.y, 12, 0, 2 * Math.PI);
                ctx.fill();

                // Inner circle (blue)
                ctx.fillStyle = '#4285F4';
                ctx.beginPath();
                ctx.arc(corner.x, corner.y, 10, 0, 2 * Math.PI);
                ctx.fill();
            });
        }
    }

    onTouchStart(event: TouchEvent) {
        event.preventDefault();
        event.stopPropagation();

        const touch = event.touches[0];
        const canvas = this.canvasRef.nativeElement;
        const rect = canvas.getBoundingClientRect();
        const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
        const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
        const x = (touch.clientX - rect.left) * scaleX;
        const y = (touch.clientY - rect.top) * scaleY;

        // Find if touching any corner (comfortable touch target)
        for (let i = 0; i < this.corners.length; i++) {
            const dx = x - this.corners[i].x;
            const dy = y - this.corners[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 35) {
                this.draggingIndex = i;
                break;
            }
        }
    }

    onTouchMove(event: TouchEvent) {
        if (this.draggingIndex !== null) {
            event.preventDefault();
            event.stopPropagation();

            const touch = event.touches[0];
            const canvas = this.canvasRef.nativeElement;
            const rect = canvas.getBoundingClientRect();
            const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
            const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
            const x = Math.max(0, Math.min((touch.clientX - rect.left) * scaleX, canvas.width));
            const y = Math.max(0, Math.min((touch.clientY - rect.top) * scaleY, canvas.height));

            this.corners[this.draggingIndex] = { x, y };
            this.drawCanvas();
        }
    }

    onTouchEnd() {
        this.draggingIndex = null;
    }

    onMouseDown(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();

        const canvas = this.canvasRef.nativeElement;
        const rect = canvas.getBoundingClientRect();
        const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
        const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
        const x = (event.clientX - rect.left) * scaleX;
        const y = (event.clientY - rect.top) * scaleY;

        // Find if clicking any corner
        for (let i = 0; i < this.corners.length; i++) {
            const dx = x - this.corners[i].x;
            const dy = y - this.corners[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 35) {
                this.draggingIndex = i;
                break;
            }
        }
    }

    onMouseMove(event: MouseEvent) {
        if (this.draggingIndex !== null) {
            event.preventDefault();
            event.stopPropagation();

            const canvas = this.canvasRef.nativeElement;
            const rect = canvas.getBoundingClientRect();
            const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
            const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
            const x = Math.max(0, Math.min((event.clientX - rect.left) * scaleX, canvas.width));
            const y = Math.max(0, Math.min((event.clientY - rect.top) * scaleY, canvas.height));

            this.corners[this.draggingIndex] = { x, y };
            this.drawCanvas();
        }
    }

    onMouseUp() {
        this.draggingIndex = null;
    }

    private getOriginalCorners(): Array<{ x: number; y: number }> {
        const cornerMarkerRadius = 20;
        const padding = cornerMarkerRadius;

        const imgWidth = this.img?.naturalWidth || this.img?.width || 1;
        const imgHeight = this.img?.naturalHeight || this.img?.height || 1;

        return this.corners.map(c => ({
            x: Math.max(0, Math.min(imgWidth, (c.x - padding) / this.scale)),
            y: Math.max(0, Math.min(imgHeight, (c.y - padding) / this.scale))
        }));
    }

    async addPage() {
        if (this.processing) return;
        this.processing = true;

        const loading = await this.loadingCtrl.create({
            message: 'Processing page...',
            spinner: 'crescent'
        });
        await loading.present();

        try {
            const originalCorners = this.getOriginalCorners();
            const croppedImage = await this.docService.cropAndTransform(this.imageData, originalCorners);
            this.sessionPages.push(croppedImage || this.imageData);
        } catch (e) {
            console.error('Error cropping image:', e);
            this.sessionPages.push(this.imageData);
        } finally {
            await loading.dismiss();
            this.processing = false;
        }

        // Now prompt to capture next photo
        if (this.platform.is('hybrid')) {
            try {
                const photo = await this.docService.takePhoto();
                if (photo.dataUrl) {
                    await this.loadNextPhoto(photo.dataUrl);
                }
            } catch (err) {
                console.log('Capture cancelled:', err);
                this.updateTitle();
            }
        } else {
            // Web camera / file fallback
            if (this.pageFileInput) {
                this.pageFileInput.nativeElement.click();
            }
        }
    }

    async onWebPageFileSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        if (input.files && input.files.length > 0) {
            const file = input.files[0];
            const dataUrl = await this.docService.fileToDataUrl(file);
            await this.loadNextPhoto(dataUrl);
            input.value = '';
        }
    }

    async retakeCurrentPhoto() {
        if (this.platform.is('hybrid')) {
            try {
                const photo = await this.docService.takePhoto();
                if (photo.dataUrl) {
                    await this.loadNextPhoto(photo.dataUrl);
                }
            } catch (e) {
                console.log('Retake cancelled', e);
            }
        } else {
            if (this.pageFileInput) {
                this.pageFileInput.nativeElement.click();
            }
        }
    }

    private async loadNextPhoto(photoDataUrl: string) {
        const loading = await this.loadingCtrl.create({
            message: 'Detecting document edges...',
            spinner: 'crescent'
        });
        await loading.present();

        const corners = await this.docService.detectDocumentEdges(photoDataUrl);
        await loading.dismiss();

        this.imageData = photoDataUrl;
        this.detectedCorners = corners || undefined;
        this.updateTitle();
        this.loadImage();
    }

    async cancel() {
        // If editing a page from editor or returning to editor
        if (this.pageIndex !== undefined || this.returnToEditor) {
            this.docService.clearEdgeDetectionState();
            this.router.navigate(['/editor'], { replaceUrl: true });
            return;
        }

        // If user already captured previous pages in this scanning session
        if (this.sessionPages.length > 0) {
            const alert = await this.alertCtrl.create({
                header: 'Finish Scanning?',
                message: `You have ${this.sessionPages.length} captured page${this.sessionPages.length > 1 ? 's' : ''}. Would you like to finish scanning or discard all pages?`,
                buttons: [
                    {
                        text: 'Discard All',
                        role: 'destructive',
                        handler: () => {
                            this.docService.clearEdgeDetectionState();
                            this.router.navigate(['/home'], { replaceUrl: true });
                        }
                    },
                    {
                        text: 'Finish & Review',
                        handler: () => {
                            this.docService.clearEdgeDetectionState();
                            this.docService.setActiveDocument({
                                images: this.sessionPages,
                                image: this.sessionPages[0],
                                originalName: this.originalName
                            });
                            this.router.navigate(['/editor'], { replaceUrl: true });
                        }
                    },
                    {
                        text: 'Continue Scanning',
                        role: 'cancel'
                    }
                ]
            });
            await alert.present();
            return;
        }

        // No pages captured yet, just return home
        this.docService.clearEdgeDetectionState();
        this.router.navigate(['/home'], { replaceUrl: true });
    }

    async confirm() {
        if (this.processing) return;
        this.processing = true;

        const originalCorners = this.getOriginalCorners();
        const loading = await this.loadingCtrl.create({
            message: 'Straightening document...',
            spinner: 'crescent'
        });
        await loading.present();

        let croppedImage: string | null = null;
        try {
            croppedImage = await this.docService.cropAndTransform(this.imageData, originalCorners);
        } catch (e) {
            console.error('Error straightening document:', e);
        } finally {
            await loading.dismiss();
            this.processing = false;
        }

        const finalPage = croppedImage || this.imageData;
        this.docService.clearEdgeDetectionState();

        // Case 1: Editing a specific page from active document
        if (this.pageIndex !== undefined) {
            const activeDoc = this.docService.getActiveDocument();
            if (activeDoc) {
                if (!activeDoc.images || activeDoc.images.length === 0) {
                    activeDoc.images = [activeDoc.image || finalPage];
                }
                const updatedImages = [...activeDoc.images];
                if (updatedImages.length > this.pageIndex) {
                    updatedImages[this.pageIndex] = finalPage;
                }
                activeDoc.images = updatedImages;
                if (this.pageIndex === 0) {
                    activeDoc.image = finalPage;
                }
                activeDoc.currentPage = this.pageIndex;
                this.docService.setActiveDocument(activeDoc);
            }
            this.router.navigate(['/editor'], { replaceUrl: true });
            return;
        }

        // Case 2: Added a page from the editor
        if (this.returnToEditor) {
            const activeDoc = this.docService.getActiveDocument();
            if (activeDoc) {
                if (!activeDoc.images) {
                    activeDoc.images = [activeDoc.image];
                }
                activeDoc.images.push(finalPage);
                activeDoc.currentPage = activeDoc.images.length - 1;
                this.docService.setActiveDocument(activeDoc);
            }
            this.router.navigate(['/editor'], { replaceUrl: true });
            return;
        }

        // Case 3: Camera scanning session (single or multi-page)
        this.sessionPages.push(finalPage);

        this.docService.setActiveDocument({
            images: this.sessionPages,
            image: this.sessionPages[0],
            originalName: this.originalName
        });
        this.router.navigate(['/editor'], { replaceUrl: true });
    }
}
