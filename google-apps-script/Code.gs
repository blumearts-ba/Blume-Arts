/**
 * BLUME ARTS - Google Drive Payment Screenshot Upload Receiver
 * ============================================================
 * Serverless Google Apps Script Web App for receiving customer
 * payment screenshots and securely saving them into the admin's
 * configured Google Drive folder without exposing any private API
 * keys, Google tokens, or service account credentials to the client.
 *
 * PRIVACY & SECURITY:
 * - Runs server-side on Google's infrastructure (100% Free).
 * - "Execute as: Me" allows customer uploads without customer Google login.
 * - Files remain private to the Google account owner by default.
 * - Authorized store admins can view/open files directly in Google Drive.
 *
 * SETUP & DEPLOYMENT INSTRUCTIONS (1 MINUTE):
 * 1. Open Google Apps Script: https://script.google.com/
 * 2. Click "+ New project" (top left) and name it "Blume Arts Payment Receiver".
 * 3. Replace all existing contents of Code.gs with this entire file.
 * 4. Click "Deploy" > "New deployment" (top right).
 * 5. Click the gear icon next to "Select type" and select "Web app".
 * 6. Set Description: "Payment Screenshot Receiver"
 * 7. Set "Execute as": "Me (<your-email>@gmail.com)"
 * 8. Set "Who has access": "Anyone"
 * 9. Click "Deploy", then "Authorize access", and grant Drive permissions.
 * 10. Copy the generated "Web app URL" (ends in /exec).
 * 11. Open your Blume Arts Admin Page > Settings:
 *     - Paste your Google Drive Folder URL into "Payment Screenshot Google Drive Folder URL"
 *     - Paste your Web app URL into "Google Apps Script Web App URL"
 *     - Click "Save Google Drive Destination".
 */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({
        success: false,
        error: "No payload received. Ensure the request body contains valid JSON."
      });
    }

    var data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse({
        success: false,
        error: "Malformed request payload: " + parseErr.message
      });
    }

    var folderId = (data.folderId || "").trim();
    var base64Data = (data.base64Data || "").trim();
    var fileName = (data.fileName || "screenshot.jpg").trim();
    var mimeType = (data.mimeType || "image/jpeg").trim().toLowerCase();
    var orderId = (data.orderId || "UNKNOWN").trim();

    // 1. Validate Target Folder ID
    if (!folderId) {
      return jsonResponse({
        success: false,
        error: "Target Google Drive Folder ID is missing or not configured."
      });
    }

    // 2. Validate MIME Type
    var allowedTypes = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp"
    };
    if (!allowedTypes[mimeType]) {
      return jsonResponse({
        success: false,
        error: "Unsupported file type: " + mimeType + ". Only JPEG, PNG, and WebP images are allowed."
      });
    }

    // 3. Validate Image Data
    if (!base64Data) {
      return jsonResponse({
        success: false,
        error: "Image data is empty."
      });
    }

    // Strip Data URL prefix if present (e.g. "data:image/jpeg;base64,")
    var cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
    var decodedBytes;
    try {
      decodedBytes = Utilities.base64Decode(cleanBase64);
    } catch (decodeErr) {
      return jsonResponse({
        success: false,
        error: "Failed to decode base64 image data: " + decodeErr.message
      });
    }

    // 4. Validate File Size (Maximum 5MB)
    var maxSizeBytes = 5 * 1024 * 1024;
    if (decodedBytes.length > maxSizeBytes) {
      return jsonResponse({
        success: false,
        error: "File size exceeds the 5MB limit. Please upload a smaller image."
      });
    }

    // 5. Access Destination Google Drive Folder
    var folder;
    try {
      folder = DriveApp.getFolderById(folderId);
    } catch (folderErr) {
      return jsonResponse({
        success: false,
        error: "Unable to access Google Drive folder (ID: " + folderId + "). Verify the Folder ID and ensure the script owner has access."
      });
    }

    // 6. Sanitize File Name & Type Routing
    var fileExt = allowedTypes[mimeType] || ".jpg";
    var cleanOrderId = orderId.replace(/[^a-zA-Z0-9_-]/g, "");
    var timestampStr = Utilities.formatDate(new Date(), "GMT+05:30", "yyyyMMdd_HHmmss");
    var uploadType = (data.type || (orderId === "ADMIN_UPI_QR" ? "upi_qr" : "payment_screenshot")).toLowerCase();
    var isUpiQr = uploadType === "upi_qr";

    var safeFileName = isUpiQr
      ? "UPI_QR_" + timestampStr + fileExt
      : "PAYMENT_" + (cleanOrderId ? cleanOrderId + "_" : "") + timestampStr + fileExt;

    // 7. Create File in Folder
    var blob = Utilities.newBlob(decodedBytes, mimeType, safeFileName);
    var driveFile = folder.createFile(blob);

    // 8. Set File Description & Permissions
    var isoTime = new Date().toISOString();
    if (isUpiQr) {
      driveFile.setDescription(
        "Blume Arts Recipient UPI QR Code\n" +
        "Uploaded At: " + isoTime + "\n" +
        "Folder ID: " + folderId
      );
      // Recipient UPI QR code needs public read so customers can scan/display it at checkout:
      try {
        driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {}
    } else {
      driveFile.setDescription(
        "Blume Arts Customer Payment Screenshot\n" +
        "Order ID: " + orderId + "\n" +
        "File Name: " + safeFileName + "\n" +
        "Uploaded At: " + isoTime + "\n" +
        "Folder ID: " + folderId
      );
      // Customer Payment Screenshots remain strictly PRIVATE to the store owner by default.
    }

    var fileId = driveFile.getId();
    var webViewLink = driveFile.getUrl();
    var directImageUrl = "https://lh3.googleusercontent.com/d/" + fileId;
    var downloadUrl = "https://drive.google.com/uc?export=download&id=" + fileId;

    return jsonResponse({
      success: true,
      provider: "google_drive",
      type: uploadType,
      fileId: fileId,
      fileName: safeFileName,
      folderId: folderId,
      webViewLink: webViewLink,
      directImageUrl: directImageUrl,
      downloadUrl: downloadUrl,
      uploadTimestamp: isoTime,
      orderId: orderId
    });
  } catch (err) {
    return jsonResponse({
      success: false,
      error: "Google Apps Script internal error: " + (err.message || err.toString())
    });
  }
}

function doGet(e) {
  return jsonResponse({
    status: "ok",
    service: "Blume Arts Google Drive Payment Receiver",
    version: "1.0",
    time: new Date().toISOString()
  });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
