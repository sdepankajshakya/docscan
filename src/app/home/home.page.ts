import { addIcons } from 'ionicons';
import {
  camera,
  searchOutline,
  homeOutline,
  documentsOutline,
  documentTextOutline,
  checkmarkOutline,
  arrowBackOutline,
  folderOutline,
  imageOutline,
  documentOutline,
} from 'ionicons/icons';

// Angular core imports
import { Component, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
// Ionic module import
import { IonicModule, Platform, ModalController, LoadingController } from '@ionic/angular';

import { DocumentProcessingService } from '../services/doc-processing.service';
import { EdgeDetectionService } from '../services/edge-detection.service';
import { DocEditorComponent } from '../components/doc-editor/doc-editor.component';
import { EdgeAdjustComponent } from '../components/edge-adjust/edge-adjust.component';

addIcons({
  camera,
  'search-outline': searchOutline,
  'home-outline': homeOutline,
  'documents-outline': documentsOutline,
  'document-text-outline': documentTextOutline,
  'checkmark-outline': checkmarkOutline,
  'arrow-back-outline': arrowBackOutline,
  'folder': folderOutline,
  'document-text': documentTextOutline,
  'image-outline': imageOutline,
  'document-outline': documentOutline,
});

@Component({
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule],
})
export class HomePage {

  @ViewChild('fileInput', { static: false })
  fileInput!: ElementRef<HTMLInputElement>;

  // Real Data
  documents: { name: string, date: string, thumbnail: string | null, fullImage?: string, type?: 'image' | 'pdf' }[] = [];

  constructor(
    private docService: DocumentProcessingService,
    private edgeService: EdgeDetectionService,
    private platform: Platform,
    private modalCtrl: ModalController,
    private loadingCtrl: LoadingController
  ) { }

  async takePhoto() {
    // If running on a hybrid device (iOS/Android), use the Native Camera
    if (this.platform.is('hybrid')) {
      try {
        const photo = await this.docService.takePhoto();

        if (photo.dataUrl) {
          await this.detectAndCrop(photo.dataUrl);
        }
      } catch (error) {
        console.error('User cancelled or error:', error);
      }
    } else {
      // On Web, use the file input to preserve filename
      this.openFilePicker();
    }
  }

  // Action for Docs Tab and Web Camera Fallback
  openFilePicker() {
    this.fileInput.nativeElement.click();
  }

  // Action for Home Tab
  goHome() {
    // Already on home, maybe scroll to top or reset something if needed
  }

  async handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      const filename = file.name;

      if (file.type === 'application/pdf') {
        // Handle PDF file - collect all pages first
        const loading = await this.loadingCtrl.create({
          message: 'Processing PDF...',
          spinner: 'crescent'
        });
        await loading.present();

        const allPages: string[] = [];
        
        await this.docService.processPDFFile(file, (imageData, pageNum, totalPages) => {
          allPages.push(imageData);
          loading.message = `Processing page ${pageNum} of ${totalPages}...`;
        });

        await loading.dismiss();

        // Open editor with all pages in single modal
        if (allPages.length > 0) {
          this.openEditorWithPages(allPages, filename.replace('.pdf', ''));
        }
      } else {
        // Handle image file
        const reader = new FileReader();
        reader.onload = async (e: any) => {
          await this.detectAndCrop(e.target.result, filename);
        };
        reader.readAsDataURL(file);
      }

      // Reset input so same file can be selected again
      input.value = '';
    }
  }

  async openEditor(imageData: string, originalName?: string) {
    const modal = await this.modalCtrl.create({
      component: DocEditorComponent,
      componentProps: {
        image: imageData,
        originalName: originalName
      }
    });

    modal.onDidDismiss().then((result) => {
      if (result.role === 'confirm' && result.data) {
        this.documents.unshift(result.data);
      }
    });

    await modal.present();
  }

  async detectAndCrop(imageData: string, originalName?: string) {
    // Show loading while detecting edges
    const loading = await this.loadingCtrl.create({
      message: 'Detecting document edges...',
      spinner: 'crescent'
    });
    await loading.present();

    // Detect edges
    const corners = await this.edgeService.detectDocumentEdges(imageData);
    await loading.dismiss();

    // Open edge adjustment modal
    const adjustModal = await this.modalCtrl.create({
      component: EdgeAdjustComponent,
      componentProps: {
        imageData: imageData,
        detectedCorners: corners
      }
    });

    adjustModal.onDidDismiss().then(async (result) => {
      if (result.role === 'confirm' && result.data) {
        // Apply perspective transform
        const transformLoading = await this.loadingCtrl.create({
          message: 'Straightening document...',
          spinner: 'crescent'
        });
        await transformLoading.present();

        const croppedImage = await this.edgeService.perspectiveTransform(imageData, result.data);
        await transformLoading.dismiss();

        if (croppedImage) {
          // Open editor with cropped image
          this.openEditor(croppedImage, originalName);
        } else {
          // If transform failed, use original
          this.openEditor(imageData, originalName);
        }
      } else {
        // User cancelled, use original image
        this.openEditor(imageData, originalName);
      }
    });

    await adjustModal.present();
  }

  async openEditorWithPages(images: string[], originalName?: string) {
    const modal = await this.modalCtrl.create({
      component: DocEditorComponent,
      componentProps: {
        images: images,
        originalName: originalName
      }
    });

    modal.onDidDismiss().then((result) => {
      if (result.role === 'confirm' && result.data) {
        this.documents.unshift(result.data);
      }
    });

    await modal.present();
  }
}