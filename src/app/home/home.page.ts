import { Component, ViewChild, ElementRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, Platform, LoadingController } from '@ionic/angular';
import { Router } from '@angular/router';
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

import { DocumentProcessingService, ScannedDocument } from '../services/doc-processing.service';

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

  private docService = inject(DocumentProcessingService);
  private platform = inject(Platform);
  private loadingCtrl = inject(LoadingController);
  private router = inject(Router);

  constructor() {
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
  }

  // Get documents from service
  get documents(): ScannedDocument[] {
    return this.docService.documents;
  }

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

        // Open editor with all pages
        if (allPages.length > 0) {
          this.docService.setActiveDocument({
            images: allPages,
            image: allPages[0], // Primary image for type compliance
            originalName: filename.replace('.pdf', '')
          });
          this.router.navigate(['/editor']);
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

  async detectAndCrop(imageData: string, originalName?: string) {
    // Show loading while detecting edges
    const loading = await this.loadingCtrl.create({
      message: 'Detecting document edges...',
      spinner: 'crescent'
    });
    await loading.present();

    // Detect edges
    const corners = await this.docService.detectDocumentEdges(imageData);
    await loading.dismiss();

    // Set state for edge adjuster and navigate
    this.docService.setEdgeDetectionState({
      imageData: imageData,
      detectedCorners: corners || undefined,
      originalName: originalName
    });

    this.router.navigate(['/edge-adjust']);
  }
}