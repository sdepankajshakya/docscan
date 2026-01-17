import { Component, Input, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ModalController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { closeOutline, checkmarkOutline } from 'ionicons/icons';

@Component({
    selector: 'app-edge-adjust',
    templateUrl: './edge-adjust.component.html',
    styleUrls: ['./edge-adjust.component.scss'],
    standalone: true,
    imports: [CommonModule, IonicModule]
})
export class EdgeAdjustComponent implements AfterViewInit {
    @Input() imageData!: string;
    @Input() detectedCorners?: Array<{ x: number; y: number }>;

    @ViewChild('canvas', { static: false })
    canvasRef!: ElementRef<HTMLCanvasElement>;

    public corners: Array<{ x: number; y: number }> = [];
    public draggingIndex: number | null = null;
    public imageLoaded = false;
    private img!: HTMLImageElement;
    private scale = 1;
    private offsetX = 0;
    private offsetY = 0;

    constructor(private modalCtrl: ModalController) {
        addIcons({ closeOutline, checkmarkOutline });
    }

    ngAfterViewInit() {
        setTimeout(() => {
            this.loadImage();
        }, 300);
    }

    private loadImage() {
        if (!this.canvasRef || !this.imageData) {
            console.error('Canvas or imageData not available');
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
            
            console.log('Image:', this.img.width, 'x', this.img.height, '| Display:', displayWidth, 'x', displayHeight);
            
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
        };
        
        this.img.src = this.imageData;
    }

    private drawCanvas() {
        const canvas = this.canvasRef.nativeElement;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        
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
            this.corners.forEach((corner, index) => {
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
        
        console.log('Touch start at:', x, y, '| Canvas rect:', rect.left, rect.top);
        
        // Find if touching any corner
        for (let i = 0; i < this.corners.length; i++) {
            const dx = x - this.corners[i].x;
            const dy = y - this.corners[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            console.log(`Corner ${i} at (${this.corners[i].x}, ${this.corners[i].y}): distance = ${distance}`);
            
            if (distance < 50) {
                this.draggingIndex = i;
                console.log('>>> Dragging corner:', i);
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
        if (this.draggingIndex !== null) {
            console.log('Touch end, released corner:', this.draggingIndex);
        }
        this.draggingIndex = null;
    }

    onMouseDown(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        
        const canvas = this.canvasRef.nativeElement;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        console.log('Mouse down at:', x, y);
        
        // Find if clicking any corner
        for (let i = 0; i < this.corners.length; i++) {
            const dx = x - this.corners[i].x;
            const dy = y - this.corners[i].y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            console.log(`Corner ${i} at (${this.corners[i].x}, ${this.corners[i].y}): distance = ${distance}`);
            
            if (distance < 50) {
                this.draggingIndex = i;
                console.log('>>> Dragging corner:', i);
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
        if (this.draggingIndex !== null) {
            console.log('Mouse up, released corner:', this.draggingIndex);
        }
        this.draggingIndex = null;
    }

    cancel() {
        this.modalCtrl.dismiss(null, 'cancel');
    }

    confirm() {
        // Scale corners back to original image coordinates
        const originalCorners = this.corners.map(c => ({
            x: c.x / this.scale,
            y: c.y / this.scale
        }));
        
        this.modalCtrl.dismiss(originalCorners, 'confirm');
    }
}
