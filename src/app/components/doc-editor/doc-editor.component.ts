import { Component, Input, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ModalController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { arrowBackOutline, checkmarkOutline } from 'ionicons/icons';
import { DocumentProcessingService } from '../../services/doc-processing.service';

@Component({
    selector: 'app-doc-editor',
    template: `
    <div class="preview-container">
      <div class="preview-header">
        <ion-button fill="clear" (click)="cancel()">
          <ion-icon name="arrow-back-outline" slot="icon-only"></ion-icon>
        </ion-button>
        <h2>Edit Document</h2>
        <ion-button fill="clear" (click)="save()">
          <ion-icon name="checkmark-outline" slot="icon-only"></ion-icon>
        </ion-button>
      </div>

      <div class="canvas-wrapper">
        <canvas #canvas></canvas>
      </div>

      <div class="filter-controls">
        <div class="filter-option" (click)="applyFilter('original')" [class.active]="activeFilter === 'original'">
          Original
        </div>
        <div class="filter-option" (click)="applyFilter('grayscale')" [class.active]="activeFilter === 'grayscale'">
          Gray
        </div>
        <div class="filter-option" (click)="applyFilter('adaptive-threshold')" [class.active]="activeFilter === 'adaptive-threshold'">
          B&W
        </div>
      </div>
    </div>
    `,
    styleUrls: ['./doc-editor.component.scss'],
    standalone: true,
    imports: [CommonModule, IonicModule]
})
export class DocEditorComponent implements AfterViewInit {

    @Input() image!: string; // Data URL
    @Input() originalName?: string;

    @ViewChild('canvas', { static: false })
    canvasRef!: ElementRef<HTMLCanvasElement>;

    public activeFilter: 'original' | 'grayscale' | 'adaptive-threshold' = 'original';
    private originalImageData?: ImageData;

    constructor(
        private modalCtrl: ModalController,
        private docService: DocumentProcessingService
    ) {
        addIcons({ arrowBackOutline, checkmarkOutline });
    }

    ngAfterViewInit() {
        this.loadImage();
    }

    private async loadImage() {
        if (this.image && this.canvasRef) {
            const result = await this.docService.loadImageToCanvas(this.canvasRef.nativeElement, this.image);
            this.originalImageData = result.original;
        }
    }

    public applyFilter(filter: 'original' | 'grayscale' | 'adaptive-threshold') {
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
        return this.modalCtrl.dismiss(null, 'cancel');
    }

    save() {
        if (!this.originalImageData || !this.canvasRef) return;

        const canvas = this.canvasRef.nativeElement;
        const thumbnail = canvas.toDataURL('image/jpeg', 0.5);

        // formatted date: DD/MM/YYYY HH:mm
        const now = new Date();
        const dateStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        let name = this.originalName;
        if (!name) {
            name = `Scan_${now.getFullYear()}${now.getMonth() + 1}${now.getDate()}_${now.getHours()}${now.getMinutes()}${now.getSeconds()}`;
        }

        const result = {
            name: name,
            date: dateStr,
            thumbnail: thumbnail,
            fullImage: canvas.toDataURL('image/jpeg', 0.8) // Save full res too if needed, or re-use thumbnail/original logic
        };

        return this.modalCtrl.dismiss(result, 'confirm');
    }
}
