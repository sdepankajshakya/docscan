# DocScan - Document Scanner App

A mobile document scanning application built with Ionic and Angular that lets users capture, process, and manage scanned documents directly on their device.

## Features

### 📸 Document Capture
- **Camera Integration** - Capture documents using device camera
- **File Picker** - Import documents from device storage (images and PDFs)
- **Auto Edge Detection** - Automatically detects document edges using OpenCV.js
- **Manual Adjustment** - Fine-tune corner positions if auto-detection needs adjustment

### 🎯 Edge Detection & Adjustment
- **Smart Detection** - Uses adaptive thresholding and bilateral filtering for robust edge detection
- **Visual Markers** - Clear corner markers show detected document boundaries
- **Touch/Mouse Support** - Drag corner markers to adjust document edges precisely
- **Real-time Preview** - See changes instantly as you adjust corners
- **Perspective Transform** - Automatically straightens the document based on adjusted corners

### 📚 Document Management
- **Local Storage** - All documents stored securely on device (no cloud sync)
- **Thumbnail Previews** - Quick visual reference of saved documents
- **Search** - Filter documents by name
- **Batch Operations** - Rename, delete, and manage multiple documents
- **File Format Support** - Save as JPG or PDF

### 🔄 Document Export
- **Multiple Formats** - Export as image (JPG) or PDF
- **Share Functionality** - Share documents via messaging, email, etc.
- **Save to Device** - Export to Documents folder for manual backup
- **Smart Cache Management** - Automatic cleanup of temporary files to prevent storage bloat

### 📱 UI Features
- **Light Mode** - Clean, light-themed interface
- **Navigation Bar** - Dark buttons on white navigation bar (Android)
- **Responsive Design** - Optimized for mobile screens
- **Smooth Animations** - Intuitive user experience

---

## How to Use

### 1. Scan a Document
1. Open the app and tap the **Scan** button (camera icon)
2. Position your document in view and take a photo
3. The app automatically detects document edges

### 2. Adjust Edges (if needed)
1. If auto-detection isn't perfect, you'll see corner markers
2. Drag the blue circles to match the actual document edges
3. The overlay shows what will be cropped/kept
4. Tap ✓ to confirm

### 3. Edit Document (Optional)
1. In the editor, you can apply filters:
   - **Grayscale** - Convert to black & white
   - **Threshold** - High contrast for text documents
   - **Invert** - Negative image
2. Adjust brightness and contrast as needed
3. Tap **Save** to finalize

### 4. Manage Documents
- **View**: Tap a document thumbnail to open
- **Rename**: Long-press → Select Rename
- **Delete**: Long-press → Select Delete
- **Share**: Long-press → Select Share
- **Export**: Long-press → Select Save As (JPG or PDF)
- **Search**: Use search bar to filter by name

---

## Technical Details

### Architecture

```
src/
├── app/
│   ├── home/                    # Main document gallery
│   ├── components/
│   │   ├── edge-adjust/         # Edge detection & adjustment UI
│   │   ├── doc-editor/          # Document editing interface
│   │   └── ...
│   ├── services/
│   │   ├── doc-processing.service.ts    # Document capture/processing
│   │   ├── edge-detection.service.ts    # OpenCV edge detection
│   │   └── ...
│   └── ...
├── assets/
│   ├── pdf.worker.min.js        # PDF.js worker
│   └── ...
└── ...
```

### Data Storage

**Storage Location:** `Directory.Data` (private app directory)
- **Android:** `/data/data/com.docscan.app/files/`
- **iOS:** `/var/mobile/Containers/Data/AppData/.../Documents/`

**What's Stored:**
- `documents.json` - Metadata for all documents (name, date, file references)
- Individual image files - Full resolution scanned documents (1-3MB each)
- Thumbnail files - Compressed previews (50-200KB each)

**Capacity:** ~500-5000 documents depending on device (most devices have several GB available)

### Edge Detection Algorithm

The app uses **OpenCV.js** with the following approach:

1. **Bilateral Filtering** - Smooths image while preserving sharp edges
2. **Adaptive Thresholding** - Handles varying lighting conditions
3. **Contour Detection** - Finds document outlines
4. **Bounding Rectangle** - Extracts corner coordinates
5. **Aspect Ratio Filtering** - Validates document-like shapes
6. **Fallback Detection** - Uses largest contour if primary detection fails

**Why this approach?**
- Simple and reliable
- Handles poor lighting better than Canny edge detection
- No complex polynomial approximations that cause data corruption
- Works with most document types (receipts, certificates, etc.)

### Document Sharing

**Android Sharing Workaround:**
- Files in `Directory.Data` are private and can't be shared directly
- Solution: Copy file to `Directory.Cache` (shareable location) during share
- **Loading Indicator** - Shows progress while preparing document (100-500ms)
- **Automatic Cleanup** - Cache files older than 24 hours are automatically deleted
- User sees seamless share experience with no manual cache management needed

### Perspective Transform

After edge detection and adjustment:
1. User adjusts corner markers to match actual document edges
2. App calculates source (image) and destination (output) points
3. OpenCV applies perspective transform (warp)
4. Document appears straight and properly oriented in result

---

## Performance Considerations

### Operations & Time Estimates

| Operation | Time | Notes |
|-----------|------|-------|
| Take photo | ~1-2s | Device camera |
| Edge detection | ~500ms-1s | OpenCV processing |
| Adjust corners | Instant | Real-time canvas drawing |
| Perspective transform | ~1-2s | Document straightening |
| Save document | ~500ms-1s | File I/O + compression |
| Share document | ~200-500ms | Copy to cache + prepare share |
| Load gallery | ~500ms-1s | Read documents.json + thumbnails |

### Optimization Notes

- **Large Documents**: If storing many documents (500+), consider adding cleanup for old files
- **Thumbnails**: Generated at fixed size for memory efficiency
- **Canvas Operations**: Real-time corner adjustment uses canvas rendering (60fps capable)
- **File I/O**: Asynchronous operations prevent UI blocking

---

## Dependencies

### Key Libraries

- **Ionic** - Mobile UI framework
- **Angular** - Frontend framework
- **Capacitor** - Native plugin bridge
  - `@capacitor/camera` - Camera access
  - `@capacitor/filesystem` - File storage
  - `@capacitor/share` - Document sharing
  - `@capacitor/status-bar` - Status bar styling
- **OpenCV.js** - Computer vision (edge detection)
- **pdf-lib** - PDF generation
- **PDF.js** - PDF rendering

### Capacitor Plugins Used

```json
{
  "@capacitor/camera": "^5.x",
  "@capacitor/filesystem": "^5.x",
  "@capacitor/share": "^5.x",
  "@capacitor/status-bar": "^5.x",
  "@capacitor/core": "^5.x"
}
```

---

## Large File Handling & Recovery

### File Size Limits

The app enforces safe limits to prevent crashes and memory issues:

- **Maximum File Size**: 50 MB per document
- **Maximum PDF Pages**: 100 pages (warning shown, processing continues)

### Processing State Recovery

If the app is backgrounded or interrupted during large file processing:

1. **State Preservation**: Processing progress is automatically saved every page
2. **App Restart**: When you reopen the app, a prompt appears asking to resume
3. **Recovery Window**: Saved state is valid for 1 hour
4. **Resume Option**: Tap "Resume" to continue from where it left off

### What Gets Saved During Processing

- Document file name
- Current progress percentage
- Number of pages already processed
- Total page count
- Last update timestamp

### Troubleshooting Large Files

**File Rejected as Too Large**
- Compress the PDF using a desktop tool
- Split large PDFs into multiple smaller files
- Maximum: 50 MB per file

**Processing Still Crashes**
- Try restarting the app and using the recovery feature
- If that doesn't work, reduce file size further
- Check device storage - ensure at least 100 MB free space

---

## Troubleshooting

### Edge Detection Not Working
- **Issue**: Markers appear at canvas corners instead of document edges
- **Solution**: Ensure good lighting on document, try again
- **Fallback**: Manually adjust corners to document edges

### Share Not Working
- **Issue**: Error about file URI
- **Solution**: This is fixed by copying to cache directory (automatic)
- **If still fails**: Ensure app has storage permissions

### Documents Not Saving
- **Issue**: Storage full error
- **Solution**: Delete some old documents to free up space
- **Typical capacity**: 500-5000 documents depending on device

### Slow Performance
- **Issue**: App feels sluggish with many documents
- **Solution**: Storage might be approaching capacity limit
- **Fix**: Delete old/duplicate documents

---

## Future Improvements

- [ ] Cloud sync/backup (optional)
- [ ] OCR text extraction
- [ ] Batch scanning (multiple pages)
- [ ] Document annotations
- [ ] Advanced filtering (deskew, brightness auto-adjust)
- [ ] Offline full-text search
- [ ] Document folders/organization

---

## License

Licensed under the MIT License.

---

## Support

For issues or feature requests, please check the app logs in browser DevTools or contact support.
