package com.docscan.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "NativeStorageExport")
public class NativeStorageExportPlugin extends Plugin {

    private String pendingBase64 = null;

    @PluginMethod
    public void exportWithSAF(PluginCall call) {
        String fileName = call.getString("fileName");
        String base64Data = call.getString("base64Data");
        String mimeType = call.getString("mimeType", "application/pdf");

        if (fileName == null || base64Data == null) {
            call.reject("fileName and base64Data are required");
            return;
        }

        this.pendingBase64 = base64Data;

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);

        startActivityForResult(call, intent, "safCallback");
    }

    @ActivityCallback
    private void safCallback(PluginCall call, ActivityResult result) {
        try {
            if (result.getResultCode() == Activity.RESULT_OK) {
                Intent data = result.getData();
                if (data != null && data.getData() != null) {
                    Uri uri = data.getData();
                    ContentResolver resolver = getContext().getContentResolver();

                    String raw = this.pendingBase64 != null ? this.pendingBase64 : "";
                    if (raw.contains(",")) {
                        raw = raw.substring(raw.indexOf(",") + 1);
                    }
                    byte[] bytes = Base64.decode(raw, Base64.DEFAULT);

                    try (OutputStream out = resolver.openOutputStream(uri)) {
                        if (out == null) {
                            call.reject("Failed to open destination stream for URI: " + uri);
                            return;
                        }
                        out.write(bytes);
                        out.flush();
                    }

                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("cancelled", false);
                    ret.put("uri", uri.toString());
                    ret.put("message", "File saved successfully via Storage Access Framework");
                    call.resolve(ret);
                    return;
                }
            }

            // User cancelled the document creation dialog
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("cancelled", true);
            ret.put("message", "Export cancelled by user");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to write to selected document: " + e.getMessage(), e);
        } finally {
            this.pendingBase64 = null;
        }
    }

    @PluginMethod
    public void exportToMediaStore(PluginCall call) {
        String fileName = call.getString("fileName");
        String base64Data = call.getString("base64Data");
        String mimeType = call.getString("mimeType", "application/pdf");
        String directory = call.getString("directory", "DOCUMENTS");

        if (fileName == null || base64Data == null) {
            call.reject("fileName and base64Data are required");
            return;
        }

        try {
            String raw = base64Data;
            if (raw.contains(",")) {
                raw = raw.substring(raw.indexOf(",") + 1);
            }
            byte[] bytes = Base64.decode(raw, Base64.DEFAULT);

            // Android 10+ (API 29+): Use MediaStore without needing legacy external storage permissions
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);

                String targetDir = "DOWNLOADS".equalsIgnoreCase(directory)
                        ? Environment.DIRECTORY_DOWNLOADS
                        : Environment.DIRECTORY_DOCUMENTS;
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, targetDir);

                Uri collectionUri = "DOWNLOADS".equalsIgnoreCase(directory)
                        ? MediaStore.Downloads.EXTERNAL_CONTENT_URI
                        : MediaStore.Files.getContentUri("external");

                Uri itemUri = resolver.insert(collectionUri, values);
                if (itemUri == null) {
                    call.reject("Failed to create MediaStore entry for " + fileName);
                    return;
                }

                try (OutputStream out = resolver.openOutputStream(itemUri)) {
                    if (out == null) {
                        call.reject("Failed to open output stream for MediaStore item: " + itemUri);
                        return;
                    }
                    out.write(bytes);
                    out.flush();
                }

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("uri", itemUri.toString());
                ret.put("path", targetDir + "/" + fileName);
                ret.put("message", "File saved to " + targetDir + " via MediaStore");
                call.resolve(ret);
            } else {
                // Android 9 and lower: Fallback to public directory write
                String targetDir = "DOWNLOADS".equalsIgnoreCase(directory)
                        ? Environment.DIRECTORY_DOWNLOADS
                        : Environment.DIRECTORY_DOCUMENTS;
                File publicDir = Environment.getExternalStoragePublicDirectory(targetDir);
                if (!publicDir.exists()) {
                    publicDir.mkdirs();
                }
                File targetFile = new File(publicDir, fileName);
                try (FileOutputStream fos = new FileOutputStream(targetFile)) {
                    fos.write(bytes);
                    fos.flush();
                }

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("path", targetFile.getAbsolutePath());
                ret.put("message", "File saved to " + targetFile.getAbsolutePath());
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("Failed to export file: " + e.getMessage(), e);
        }
    }
}

