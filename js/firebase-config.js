// ============================================================
// BLUME ARTS — Firebase configuration
// ------------------------------------------------------------
// Uses Firebase Firestore ONLY.
// No Firebase Cloud Storage is initialized or used.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

export const firebaseConfig = {
  apiKey: "AIzaSyCQsW6ZEpahRVIxzCPft2nGQ6BacrdWcjY",
  authDomain: "blume-arts-6f2af.firebaseapp.com",
  projectId: "blume-arts-6f2af",
  storageBucket: "blume-arts-6f2af.firebasestorage.app",
  messagingSenderId: "912209421740",
  appId: "1:912209421740:web:c7827a9900af6dc0538609",
  measurementId: "G-9K6LHDCKCX"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Fallback settings used until settings/business loads from Firestore
export const DEFAULT_SETTINGS = {
  businessName: "Blume Arts",
  phone: "7397 536 605",
  whatsapp: "7397 536 605", // country code + number, digits only
  email: "blumearts34@gmail.com",
  instagram: "@blume_arts07",
  instagramUrl: "https://instagram.com/blume_arts07",
  address: "",
  description: "Handmade pipe cleaner flowers, crafted with love.",
  deliveryInfo: "Delivery details shared after order confirmation on WhatsApp.",
  footerText: "Handmade With Love",
};