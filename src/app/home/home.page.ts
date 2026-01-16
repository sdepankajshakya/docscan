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
} from 'ionicons/icons';

// Angular core imports
import { Component, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
// Ionic module import
import { IonicModule, Platform, ModalController } from '@ionic/angular';

import { DocumentProcessingService } from '../services/doc-processing.service';
import { DocEditorComponent } from '../components/doc-editor/doc-editor.component';

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
  documents: { name: string, date: string, thumbnail: string | null }[] = [];

  constructor(
    private docService: DocumentProcessingService,
    privateplatform: Platform, // Typo fixed below
    private platform: Platform,
    private modalCtrl: ModalController
  ) { }

  async takePhoto() {
    // If running on a hybrid device (iOS/Android), use the Native Camera
    if (this.platform.is('hybrid')) {
      try {
        const photo = await this.docService.takePhoto();

        if (photo.dataUrl) {
          this.openEditor(photo.dataUrl);
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

  handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      const filename = file.name;

      const reader = new FileReader();
      reader.onload = (e: any) => {
        this.openEditor(e.target.result, filename);
      };
      reader.readAsDataURL(file);

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
}