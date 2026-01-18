import { Component, ViewChild, ElementRef, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { 
  IonHeader, 
  IonToolbar, 
  IonTitle, 
  IonContent, 
  IonRefresher, 
  IonRefresherContent, 
  IonIcon, 
  IonGrid, 
  IonRow, 
  IonCol,
  IonTabs,
  IonTab,
  IonTabBar,
  IonTabButton,
  Platform, 
  LoadingController, 
  ActionSheetController, 
  AlertController 
} from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { Share } from '@capacitor/share';
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
  ellipsisVertical,
  trashOutline,
  createOutline,
  shareOutline,
  folderOpenOutline,
  closeCircle
} from 'ionicons/icons';

import { DocumentProcessingService, ScannedDocument } from '../services/doc-processing.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    IonIcon,
    IonGrid,
    IonRow,
    IonCol,
    IonTabs,
    IonTab,
    IonTabBar,
    IonTabButton
  ],
})
export class HomePage implements OnInit {

  @ViewChild('fileInput', { static: false })
  fileInput!: ElementRef<HTMLInputElement>;

  public searchQuery = '';

  private docService = inject(DocumentProcessingService);
  private platform = inject(Platform);
  private loadingCtrl = inject(LoadingController);
  private actionSheetCtrl = inject(ActionSheetController);
  private alertCtrl = inject(AlertController);
  private router = inject(Router);

  documents: ScannedDocument[] = [];

  constructor() {
    addIcons({
      camera,
      'search-outline': searchOutline,
      'home-outline': homeOutline,
      'documents-outline': documentsOutline,
      'document-text-outline': documentTextOutline,
      'checkmark-outline': checkmarkOutline,
      'arrow-back-outline': arrowBackOutline,
      'folder-outline': folderOutline,
      'image-outline': imageOutline,
      'document-outline': documentOutline,
      'ellipsis-vertical': ellipsisVertical,
      'trash-outline': trashOutline,
      'create-outline': createOutline,
      'share-outline': shareOutline,
      'folder-open-outline': folderOpenOutline,
      'close-circle': closeCircle
    });
  }

  ngOnInit() {
    this.refreshDocuments();
  }

  async refreshDocuments() {
    await this.docService.loadDocuments();
    this.documents = this.docService.documents;

    // Pre-load thumbnails for high performance and Web compatibility
    for (const doc of this.documents) {
      if (!doc.displayThumbnail) {
        doc.displayThumbnail = await this.docService.resolveThumbnailUrl(doc);
      }
    }
  }

  get filteredDocuments(): ScannedDocument[] {
    const docs = this.documents;
    if (!this.searchQuery) return docs;

    return docs.filter(doc =>
      doc.name.toLowerCase().includes(this.searchQuery.toLowerCase())
    );
  }

  async handleRefresh(event: any) {
    await this.refreshDocuments();
    event.target.complete();
  }

  search(event: any) {
    this.searchQuery = event.target.value;
  }

  async presentDocumentOptions(doc: ScannedDocument) {
    const actionSheet = await this.actionSheetCtrl.create({
      header: doc.name,
      buttons: [
        {
          text: 'Share',
          icon: 'share-outline',
          handler: () => {
            this.shareDocument(doc);
          }
        },
        {
          text: 'Rename',
          icon: 'create-outline',
          handler: () => {
            this.presentRenameAlert(doc);
          }
        },
        {
          text: 'Save as PDF',
          icon: 'document-text-outline',
          handler: () => {
            this.saveAsPDF(doc);
          }
        },
        {
          text: 'Save as Image',
          icon: 'image-outline',
          handler: () => {
            this.saveAsImage(doc);
          }
        },
        {
          text: 'Delete',
          role: 'destructive',
          icon: 'trash-outline',
          handler: async () => {
            await this.docService.deleteDocument(doc);
            this.refreshDocuments();
          }
        }
      ],
    });

    await actionSheet.present();
  }

  async presentRenameAlert(doc: ScannedDocument) {
    const alert = await this.alertCtrl.create({
      header: 'Rename Document',
      inputs: [
        {
          name: 'name',
          type: 'text',
          placeholder: 'Filename',
          value: doc.name
        }
      ],
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Save',
          handler: (data) => {
            if (data.name) {
              this.docService.renameDocument(doc, data.name);
            }
          }
        }
      ]
    });
    await alert.present();
  }

  async shareDocument(doc: ScannedDocument) {
    if (!doc.fullImage) return;

    try {
      let shareUrl = doc.fullImage;

      // If stored as filename, resolve to full URI
      if (!doc.fullImage.startsWith('data:')) {
        import('@capacitor/filesystem').then(async ({ Filesystem, Directory }) => {
          try {
            const uriResult = await Filesystem.getUri({
              path: doc.fullImage!,
              directory: Directory.Data
            });
            shareUrl = uriResult.uri;

            await Share.share({
              title: doc.name,
              text: 'Shared via DocScan',
              url: shareUrl,
              dialogTitle: 'Share Document'
            });
          } catch (e) {
            console.error('Error resolving file URI', e);
          }
        });
      } else {
        // Web/Data URL sharing (might be limited)
        await Share.share({
          title: doc.name,
          text: 'Shared via DocScan',
          url: doc.fullImage,
          dialogTitle: 'Share Document'
        });
      }
    } catch (e) {
      console.error('Error sharing', e);
    }
  }

  async openDocument(doc: ScannedDocument) {
    if (!doc.fullImage) return;

    const loading = await this.loadingCtrl.create({
      message: 'Opening document...',
      duration: 2000
    });
    await loading.present();

    let imageSrc = doc.fullImage;
    // If it's a file path (not base64), load it
    if (!doc.fullImage.startsWith('data:')) {
      const loaded = await this.docService.loadDocumentImage(doc.fullImage);
      if (loaded) {
        imageSrc = loaded;
      } else {
        await loading.dismiss();
        return;
      }
    }

    // Check if it is a PDF -> Extract pages
    if (doc.type === 'pdf' || imageSrc.startsWith('data:application/pdf')) {
      try {
        loading.message = 'Processing PDF pages...';
        const pages = await this.docService.extractPagesFromPDFData(imageSrc);
        await loading.dismiss();

        if (pages.length > 0) {
          this.docService.setActiveDocument({
            images: pages,
            image: pages[0],
            originalName: doc.name,
            originalDoc: doc
          });
          this.router.navigate(['/editor']);
        }
        return;
      } catch (e) {
        console.error('Error parsing PDF', e);
        await loading.dismiss();
        return; // Or show error toast
      }
    }

    await loading.dismiss();

    this.docService.setActiveDocument({
      image: imageSrc,
      originalName: doc.name,
      originalDoc: doc
    });
    this.router.navigate(['/editor']);
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
    this.searchQuery = '';
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

  async saveAsPDF(doc: ScannedDocument) {
    if (!doc.fullImage) return;

    const loading = await this.loadingCtrl.create({
      message: 'Saving as PDF...',
      duration: 3000
    });
    await loading.present();

    try {
      await this.docService.saveDocumentAs(doc, 'pdf');
    } catch (e) {
      console.error('Error saving PDF', e);
    } finally {
      await loading.dismiss();
    }
  }

  async saveAsImage(doc: ScannedDocument) {
    if (!doc.fullImage || doc.type === 'pdf') return;

    const loading = await this.loadingCtrl.create({
      message: 'Saving Copy...',
      duration: 2000
    });
    await loading.present();

    try {
      await this.docService.saveDocumentAs(doc, 'image');
    } catch (e) {
      console.error('Error saving image', e);
    } finally {
      await loading.dismiss();
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

  getThumbnailUrl(doc: ScannedDocument): string {
    return doc.displayThumbnail || '';
  }
}