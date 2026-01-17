import { Component, ViewChild, ElementRef, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, LoadingController } from '@ionic/angular';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { closeOutline, checkmarkOutline } from 'ionicons/icons';
import { DocumentProcessingService } from '../../services/doc-processing.service';

@Component({
    selector: 'app-edge-adjust',
    templateUrl: './edge-adjust.component.html',
    styleUrls: ['./edge-adjust.component.scss'],
    standalone: true,
    imports: [CommonModule, IonicModule]
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

            // Calculate scale to fit viewport with margin for corners
            const maxWidth = window.innerWidth - 80;
            const maxHeight = window.innerHeight - 350;

            const scaleX = maxWidth / this.img.width;
            const scaleY = maxHeight / this.img.height;
            this.scale = Math.min(scaleX, scaleY, 0.85);

            // Set canvas to scaled size
            const displayWidth = this.img.width * this.scale;
            const displayHeight = this.img.height * this.scale;

            canvas.width = displayWidth;
            canvas.height = displayHeight;

            // Set default corners or use detected ones
            if (this.detectedCorners && this.detectedCorners.length === 4) {
                // Scale detected corners to canvas size
                this.corners = this.detectedCorners.map(c => ({
                    x: c.x * this.scale,
                    y: c.y * this.scale
                }));
            } else {
                // Default corners (full canvas with padding)
                const padding = 30;
                this.corners = [
                    { x: padding, y: padding },
                    { x: canvas.width - padding, y: padding },
                    { x: canvas.width - padding, y: canvas.height - padding },
                    { x: padding, y: canvas.height - padding }
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

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw image first
        ctx.drawImage(this.img, 0, 0, canvas.width, canvas.height);

        // Draw semi-transparent overlay over entire image
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

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
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(this.corners[0].x, this.corners[0].y);
            ctx.lineTo(this.corners[1].x, this.corners[1].y);
            ctx.lineTo(this.corners[2].x, this.corners[2].y);
            ctx.lineTo(this.corners[3].x, this.corners[3].y);
            ctx.closePath();
            ctx.stroke();

            // Draw corner points
            this.corners.forEach((corner) => {
                // Outer circle (white)
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.arc(corner.x, corner.y, 25, 0, 2 * Math.PI);
                ctx.fill();

                // Inner circle (blue)
                ctx.fillStyle = '#4285F4';
                ctx.beginPath();
                ctx.arc(corner.x, corner.y, 20, 0, 2 * Math.PI);
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

        // Find if touching any corner
        for (let i = 0; i < this.corners.length; i++) {
            const dx = x - this.corners[i].x;
            const dy = y - this.corners[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 50) {
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

        // Find if clicking any corner
        for (let i = 0; i < this.corners.length; i++) {
            const dx = x - this.corners[i].x;
            const dy = y - this.corners[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 50) {
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
        const originalCorners = this.corners.map(c => ({
            x: c.x / this.scale,
            y: c.y / this.scale
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
