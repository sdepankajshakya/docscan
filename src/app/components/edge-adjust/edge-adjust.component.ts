import { Component, ViewChild, ElementRef, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonButton, IonIcon, LoadingController } from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { closeOutline, checkmarkOutline } from 'ionicons/icons';
import { DocumentProcessingService } from '../../services/doc-processing.service';

@Component({
    selector: 'app-edge-adjust',
    templateUrl: './edge-adjust.component.html',
    styleUrls: ['./edge-adjust.component.scss'],
    standalone: true,
    imports: [CommonModule, IonButton, IonIcon]
})
export class EdgeAdjustComponent implements AfterViewInit {

    @ViewChild('canvas', { static: false })
    canvasRef!: ElementRef<HTMLCanvasElement>;

    public corners: Array<{ x: number; y: number }> = [];
    public draggingIndex: number | null = null;
    public imageLoaded = false;

    private img!: HTMLImageElement;
    private scale = 1;
    private imageData!: string;
    private detectedCorners?: Array<{ x: number; y: number }>;
    private originalName?: string;

    private docService = inject(DocumentProcessingService);
    private router = inject(Router);
    private loadingCtrl = inject(LoadingController);

    constructor() {
        addIcons({ closeOutline, checkmarkOutline });
    }

    ngAfterViewInit() {
        // Load state from service
        const state = this.docService.getEdgeDetectionState();
        if (!state || !state.imageData) {
            console.error('No image data found for edge adjustment');
            this.cancel();
            return;
        }

        this.imageData = state.imageData;
        this.detectedCorners = state.detectedCorners;
        this.originalName = state.originalName;

        // Small delay to ensure view is ready
        setTimeout(() => {
            this.loadImage();
        }, 100);
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

            // Calculate scale to fit viewport with margin for corners
            const maxWidth = window.innerWidth - 80;
            const maxHeight = window.innerHeight - 350;

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
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;

        // Find if touching any corner (reduced radius to match smaller markers)
        for (let i = 0; i < this.corners.length; i++) {
            const dx = x - this.corners[i].x;
            const dy = y - this.corners[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 28) {
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
            const x = Math.max(0, Math.min(touch.clientX - rect.left, canvas.width));
            const y = Math.max(0, Math.min(touch.clientY - rect.top, canvas.height));

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
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // Find if clicking any corner (reduced radius to match smaller markers)
        for (let i = 0; i < this.corners.length; i++) {
            const dx = x - this.corners[i].x;
            const dy = y - this.corners[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 28) {
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
            const x = Math.max(0, Math.min(event.clientX - rect.left, canvas.width));
            const y = Math.max(0, Math.min(event.clientY - rect.top, canvas.height));

            this.corners[this.draggingIndex] = { x, y };
            this.drawCanvas();
        }
    }

    onMouseUp() {
        this.draggingIndex = null;
    }

    cancel() {
        this.docService.clearEdgeDetectionState();
        this.router.navigate(['/home'], { replaceUrl: true });
    }

    async confirm() {
        // Scale corners back to original image coordinates
        // Account for the padding offset that was added to the canvas
        const cornerMarkerRadius = 20;
        const padding = cornerMarkerRadius;

        const originalCorners = this.corners.map(c => ({
            x: (c.x - padding) / this.scale,
            y: (c.y - padding) / this.scale
        }));

        const loading = await this.loadingCtrl.create({
            message: 'Straightening document...',
            spinner: 'crescent'
        });
        await loading.present();

        const croppedImage = await this.docService.cropAndTransform(this.imageData, originalCorners);
        await loading.dismiss();

        this.docService.clearEdgeDetectionState();

        if (croppedImage) {
            // Set active document logic for editor
            this.docService.setActiveDocument({
                image: croppedImage,
                originalName: this.originalName
            });
            this.router.navigate(['/editor'], { replaceUrl: true });
        } else {
            // Fallback to original image if crop fails
            this.docService.setActiveDocument({
                image: this.imageData,
                originalName: this.originalName
            });
            this.router.navigate(['/editor'], { replaceUrl: true });
        }
    }
}
