const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

/**
 * Helper function to verify that the requesting user is an active Primary Admin in Firestore.
 */
async function verifyPrimaryAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const callerUid = context.auth.uid;
  const callerDoc = await admin.firestore().collection("adminUsers").doc(callerUid).get();

  if (!callerDoc.exists || callerDoc.data().status !== "active" || callerDoc.data().role !== "Primary Admin") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only an active Primary Admin can perform this action."
    );
  }
}

/**
 * Privileged Cloud Function: Add New Admin User
 * Creates user in Firebase Auth and records profile in Firestore.
 */
exports.addAdminUser = functions.https.onCall(async (data, context) => {
  await verifyPrimaryAdmin(context);

  const { email, password, name, role, status } = data;

  if (!email || !password || !name || !role) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Missing required fields: email, password, name, role."
    );
  }

  if (password.length < 6) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Password must be at least 6 characters long."
    );
  }

  try {
    // 1. Create user in Firebase Auth via Admin SDK
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: name,
      disabled: status === "disabled"
    });

    // 2. Set Custom User Claims for Firebase Auth Role-Based Access Control if needed
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, admin: true });

    // 3. Store admin metadata in Firestore (NEVER storing password)
    await admin.firestore().collection("adminUsers").doc(userRecord.uid).set({
      uid: userRecord.uid,
      name: name,
      email: email,
      role: role,
      status: status || "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: null
    });

    return {
      success: true,
      message: "Admin account created successfully.",
      uid: userRecord.uid
    };
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

/**
 * Privileged Cloud Function: Toggle Admin Status (Enable/Disable)
 */
exports.setAdminStatus = functions.https.onCall(async (data, context) => {
  await verifyPrimaryAdmin(context);

  const { targetUid, status } = data;
  if (!targetUid || !["active", "disabled"].includes(status)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid arguments.");
  }

  // Prevent disabling Primary Admin
  const targetDoc = await admin.firestore().collection("adminUsers").doc(targetUid).get();
  if (targetDoc.exists && targetDoc.data().role === "Primary Admin") {
    throw new functions.https.HttpsError("permission-denied", "Primary Admin account status cannot be changed.");
  }

  // Disable in Firebase Auth
  await admin.auth().updateUser(targetUid, {
    disabled: status === "disabled"
  });

  // Update status in Firestore
  await admin.firestore().collection("adminUsers").doc(targetUid).update({
    status: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true };
});

/**
 * Privileged Cloud Function: Remove Admin Account
 */
exports.removeAdminUser = functions.https.onCall(async (data, context) => {
  await verifyPrimaryAdmin(context);

  const { targetUid } = data;
  if (!targetUid) {
    throw new functions.https.HttpsError("invalid-argument", "Target UID is required.");
  }

  const targetDoc = await admin.firestore().collection("adminUsers").doc(targetUid).get();
  if (targetDoc.exists && targetDoc.data().role === "Primary Admin") {
    throw new functions.https.HttpsError("permission-denied", "Primary Admin account cannot be removed.");
  }

  // Delete from Firebase Auth
  await admin.auth().deleteUser(targetUid);

  // Delete from Firestore
  await admin.firestore().collection("adminUsers").doc(targetUid).delete();

  return { success: true };
});
