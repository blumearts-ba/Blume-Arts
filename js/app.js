import { db, DEFAULT_SETTINGS } from "./firebase-config.js";
import {
  collection, onSnapshot, addDoc, serverTimestamp, doc, getDoc,
  runTransaction, query, where, getDocs, updateDoc, setDoc, orderBy, arrayUnion
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// ---------- EMOJI SANITIZER FOR ZERO EMOJI COMPLIANCE ----------
function removeEmojis(str) {
  if (!str || typeof str !== "string") return str || "";
  return str.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]|\uD83D[\uFF00-\uFFFF]|\uD83E[\uFF00-\uFFFF])/gu, '').replace(/\s+/g, ' ').trim();
}

// ---------- DEFAULT PLACEHOLDER ----------
const DEFAULT_PRODUCT_IMAGE = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><rect width='400' height='400' fill='#f3d7d9'/><text x='50%' y='50%' font-size='28' fill='#a8616f' text-anchor='middle' dy='.3em' font-family='serif'>Blume Arts</text></svg>`
);

function getProductImage(product) {
  if (!product) return DEFAULT_PRODUCT_IMAGE;
  const url = product.imageUrl || product.imageBase64 || product.imageURL || product.image_url || product.image || "";
  return (typeof url === "string" && url.trim()) ? url.trim() : DEFAULT_PRODUCT_IMAGE;
}

// ---------- STATE ----------
let PRODUCTS = [];
let CATEGORIES = [];
let SETTINGS = { ...DEFAULT_SETTINGS };
let CART = JSON.parse(localStorage.getItem("blume_cart") || "[]");
let activeProduct = null;
let pdQty = 1;
let pdSelectedColor = null;
let currentStep = 1;
let checkoutMode = "cart"; // "cart" | "buyNow"
let buyNowItem = null;
let lastOrder = null;
try {
  const cachedOrder = sessionStorage.getItem("blume_last_order");
  if (cachedOrder) lastOrder = JSON.parse(cachedOrder);
} catch (e) {}

let CURRENT_CUSTOMER_PROFILE = null;
let CURRENT_CUSTOMER_VAULT_KEY = null;
let CURRENT_CUSTOMER_REG_KEY = null;
try {
  const cachedProfile = sessionStorage.getItem("blume_saved_profile");
  if (cachedProfile) {
    CURRENT_CUSTOMER_PROFILE = JSON.parse(cachedProfile);
  }
  CURRENT_CUSTOMER_VAULT_KEY = sessionStorage.getItem("blume_vault_key") || null;
  CURRENT_CUSTOMER_REG_KEY = sessionStorage.getItem("blume_reg_key") || null;
} catch (e) {
  console.warn("Could not parse cached customer profile:", e);
}
let currentUploadedScreenshotDataUrl = "";
let selectedPaymentMethod = "COD";
let checkoutOptionMode = "saved"; // "saved" | "manual"

const $ = (sel) => document.querySelector(sel);
const money = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

// ---------- CUSTOMER IDENTITY & SECURITY UTILITIES ----------
async function deriveVaultKey(mobile, password) {
  const clean = String(mobile || "").replace(/\D/g, "");
  const pwd = String(password || "").trim();
  const encoder = new TextEncoder();
  const rawKey = `blume_vault_v2_${clean}#${pwd}_salt_blume_2026_arts`;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(rawKey));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function deriveRegistryKey(mobile) {
  const clean = String(mobile || "").replace(/\D/g, "");
  const encoder = new TextEncoder();
  const rawKey = `blume_reg_v2_${clean}_salt_blume_2026_arts`;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(rawKey));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPasswordVerifier(password) {
  const pwd = String(password || "").trim();
  const encoder = new TextEncoder();
  const rawKey = `blume_pwd_verifier_salt_2026_${pwd}`;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(rawKey));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashCustomerPin(phone, pin) {
  const clean = String(phone || "").replace(/\D/g, "");
  const encoder = new TextEncoder();
  const data = encoder.encode(`blume_customer_${clean}_salt_${pin}_2026`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function extractDriveFolderIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const str = url.trim();
  const matchFolders = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (matchFolders && matchFolders[1]) return matchFolders[1];
  const matchIdParam = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (matchIdParam && matchIdParam[1]) return matchIdParam[1];
  if (/^[a-zA-Z0-9_-]{20,50}$/.test(str)) return str;
  return null;
}

// Persistent Payment Screenshot Upload (Google Drive / Cloudinary / ImgBB)
async function uploadPaymentScreenshotFile(file, orderId = "UNKNOWN") {
  if (!file) throw new Error("No file selected.");
  if (!file.type.match(/^image\/(jpeg|png|webp)$/i)) {
    throw new Error("Please upload a valid image file (JPG, PNG, or WebP).");
  }
  const maxSizeBytes = 5 * 1024 * 1024; // 5 MB
  if (file.size > maxSizeBytes) {
    throw new Error("Screenshot image must be less than 5MB in size.");
  }

  const driveFolderUrl = (SETTINGS.googleDriveFolderUrl || "").trim();
  const driveFolderId = (SETTINGS.googleDriveFolderId || "").trim();
  const driveScriptUrl = (SETTINGS.googleDriveScriptUrl || "").trim();
  const effectiveFolderId = driveFolderId || extractDriveFolderIdFromUrl(driveFolderUrl);

  // 1. Google Drive Destination (Primary)
  if (driveFolderUrl || effectiveFolderId) {
    if (!effectiveFolderId) {
      throw new Error("The Payment Screenshot Google Drive Folder URL is invalid. Please contact the store owner or verify the folder link in Admin Settings.");
    }
    if (!driveScriptUrl) {
      throw new Error("Google Drive upload service is not configured. The store owner must provide the Google Apps Script Web App URL in Admin Settings > Business & App Settings.");
    }

    // Convert file to Base64
    const base64Data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to read image file data."));
      reader.readAsDataURL(file);
    });

    const fileExt = file.type === "image/png" ? ".png" : (file.type === "image/webp" ? ".webp" : ".jpg");
    const cleanOrderId = (orderId || "BA-" + Date.now()).replace(/[^a-zA-Z0-9_-]/g, "");
    const fileName = `PAYMENT_${cleanOrderId}_${Date.now()}${fileExt}`;

    const payload = {
      folderId: effectiveFolderId,
      base64Data: base64Data,
      fileName: fileName,
      mimeType: file.type || "image/jpeg",
      orderId: orderId || "UNKNOWN"
    };

    let res;
    try {
      res = await fetch(driveScriptUrl, {
        method: "POST",
        mode: "cors",
        redirect: "follow",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify(payload)
      });
    } catch (networkErr) {
      throw new Error("Failed to connect to Google Drive service. Please check your network connection or verify the Google Apps Script Web App URL.");
    }

    if (!res.ok) {
      throw new Error(`Google Drive upload request failed with HTTP ${res.status}.`);
    }

    const text = await res.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch (jsonErr) {
      throw new Error("Unexpected response from Google Drive receiver: " + text.slice(0, 100));
    }

    if (!result.success || !result.fileId) {
      throw new Error(result.error || "Google Drive upload failed. Please verify that the Google Drive folder exists and the Web App is authorized.");
    }

    return {
      provider: "google_drive",
      fileId: result.fileId,
      fileName: result.fileName || fileName,
      folderId: result.folderId || effectiveFolderId,
      webViewLink: result.webViewLink || `https://drive.google.com/file/d/${result.fileId}/view`,
      uploadTimestamp: result.uploadTimestamp || new Date().toISOString()
    };
  }

  // 2. Cloudinary Unsigned Upload (Secondary / Legacy fallback)
  const cloudName = SETTINGS.cloudinaryCloudName;
  const uploadPreset = SETTINGS.cloudinaryUploadPreset;
  if (cloudName && uploadPreset) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", uploadPreset);
    formData.append("folder", "blume_arts_payments");

    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: "POST",
      body: formData
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error?.message || "Cloudinary upload failed. Check Cloud Name & Preset in Admin Settings.");
    }
    const data = await res.json();
    if (!data.secure_url) throw new Error("Failed to obtain image URL from Cloudinary.");
    return {
      provider: "cloudinary",
      url: data.secure_url,
      webViewLink: data.secure_url
    };
  }

  // 3. ImgBB Upload (Alternative fallback)
  const imgbbKey = SETTINGS.imgbbApiKey;
  if (imgbbKey) {
    const formData = new FormData();
    formData.append("image", file);

    const res = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
      method: "POST",
      body: formData
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error?.message || "ImgBB upload failed. Check API key in Admin Settings.");
    }
    const data = await res.json();
    if (!data.data?.url) throw new Error("Failed to obtain image URL from ImgBB.");
    return {
      provider: "imgbb",
      url: data.data.url,
      webViewLink: data.data.url
    };
  }

  // 4. Safe compressed fallback if external destination is not yet configured
  try {
    const compressedData = await compressImageFileToDataUrl(file, 600, 600, 0.65);
    return {
      provider: "firestore_compressed",
      url: compressedData,
      webViewLink: compressedData,
      fileId: `LOCAL_${Date.now()}`
    };
  } catch (compErr) {
    throw new Error(
      "Payment screenshot destination is not configured. The store owner can configure the Payment Screenshot Google Drive Folder URL in Admin Settings."
    );
  }
}

function compressImageFileToDataUrl(file, maxWidth = 800, maxHeight = 800, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.match(/^image\/(jpeg|png|webp)$/i)) {
      return reject(new Error("Please upload a valid image (JPG, PNG, or WebP)."));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to process image file."));
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- TOAST ----------
function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = removeEmojis(msg);
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- SETTINGS ----------
async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    if (snap.exists()) SETTINGS = { ...SETTINGS, ...snap.data() };
  } catch (e) { console.warn("Using default settings:", e.message); }
  applySettingsToUI();
}
function applySettingsToUI() {
  if ($("#contactPhone")) $("#contactPhone").textContent = SETTINGS.phone;
  if ($("#contactEmail")) $("#contactEmail").textContent = SETTINGS.email;
  if ($("#contactInsta")) $("#contactInsta").textContent = SETTINGS.instagram;
  if ($("#footerPhone")) $("#footerPhone").textContent = SETTINGS.phone;
  if ($("#footerEmail")) $("#footerEmail").textContent = SETTINGS.email;
  if ($("#footerInsta")) { $("#footerInsta").textContent = SETTINGS.instagram; $("#footerInsta").href = SETTINGS.instagramUrl; }
  if ($("#footerText")) $("#footerText").textContent = removeEmojis(SETTINGS.footerText || SETTINGS.description);
  if ($("#callBtn")) $("#callBtn").href = "tel:" + SETTINGS.phone.replace(/\s/g, "");
  if ($("#emailBtn")) $("#emailBtn").href = "mailto:" + SETTINGS.email;
  if ($("#instaBtn")) $("#instaBtn").href = SETTINGS.instagramUrl;
  if ($("#waBtn")) $("#waBtn").href = `https://wa.me/${SETTINGS.whatsapp}`;
}

// ---------- PRODUCTS ----------
function loadProducts() {
  onSnapshot(collection(db, "products"), (snap) => {
    PRODUCTS = [];
    snap.forEach((d) => {
      const data = d.data();
      const rawDel = data.deliveryCharge !== undefined ? data.deliveryCharge : (data.delivery_charge || data.deliveryFee || 0);
      const deliveryCharge = Number(rawDel);

      PRODUCTS.push({
        id: d.id,
        ...data,
        name: removeEmojis(data.name),
        description: removeEmojis(data.description),
        price: Number(data.price || 0),
        deliveryCharge: isNaN(deliveryCharge) ? 0 : deliveryCharge,
        unlimitedStock: Boolean(data.unlimitedStock)
      });
    });

    // CRITICAL: Sync CART array items in localStorage with latest PRODUCTS from Firestore
    if (CART && CART.length) {
      CART.forEach(item => {
        const matchedProduct = PRODUCTS.find(p => p.id === item.id);
        if (matchedProduct) {
          item.name = removeEmojis(matchedProduct.name);
          item.price = Number(matchedProduct.price || 0);
          item.deliveryCharge = Number(matchedProduct.deliveryCharge || 0);
        }
      });
      saveCart();
    }

    PRODUCTS.sort((a, b) => {
      const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0);
      const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0);
      return tB - tA;
    });

    renderProducts();
    renderCart();
  }, (err) => {
    console.warn("Product listener error:", err.message);
    if ($("#productGrid")) $("#productGrid").innerHTML = `<div class="empty-state">Unable to load products.</div>`;
  });
}

function loadCategories() {
  onSnapshot(collection(db, "categories"), (snap) => {
    CATEGORIES = [];
    snap.forEach((d) => {
      if (d.data().hidden !== true) {
        CATEGORIES.push({ id: d.id, ...d.data(), name: removeEmojis(d.data().name) });
      }
    });
    const sel = $("#categoryFilter");
    if (sel) {
      sel.innerHTML = `<option value="">All Categories</option>` +
        CATEGORIES.map(c => `<option value="${c.name}">${c.name}</option>`).join("");
    }
  });
}

function getFilteredProducts() {
  let list = PRODUCTS.filter(p => p.available !== false);
  const searchInput = $("#searchInput");
  const search = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const catFilter = $("#categoryFilter");
  const cat = catFilter ? catFilter.value : "";
  const sortFilter = $("#sortFilter");
  const sort = sortFilter ? sortFilter.value : "";

  if (search) list = list.filter(p => (p.name || "").toLowerCase().includes(search));
  if (cat) list = list.filter(p => p.category === cat);
  if (sort === "price-asc") list.sort((a, b) => (a.price || 0) - (b.price || 0));
  else if (sort === "price-desc") list.sort((a, b) => (b.price || 0) - (a.price || 0));
  else if (sort === "featured") list = list.filter(p => p.featured);
  return list;
}

function renderProducts() {
  const grid = $("#productGrid");
  if (!grid) return;
  const list = getFilteredProducts();
  if (!list.length) {
    grid.innerHTML = `<div class="empty-state">No products found. Please check back soon.</div>`;
    return;
  }

  grid.innerHTML = list.map((p, i) => {
    const imageSource = getProductImage(p);
    const cleanName = removeEmojis(p.name);
    const isUnlimited = Boolean(p.unlimitedStock);
    const stockNum = Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0));
    const isOut = !isUnlimited && stockNum <= 0;
    const ratingHtml = (p.reviewCount && p.reviewCount > 0)
      ? `<div class="rating-badge">★ ${(Number(p.avgRating) || 5).toFixed(1)} (${p.reviewCount})</div>`
      : "";

    return `
      <div class="product-card" style="animation-delay:${i * 0.04}s" data-id="${p.id}">
        <div class="product-img-wrap">
          <img src="${imageSource}" alt="${cleanName}" loading="lazy">
          ${p.featured ? '<span class="product-badge">Featured</span>' : ""}
        </div>
        <div class="product-info">
          <h3>${cleanName}</h3>
          ${ratingHtml}
          <div class="desc">${(removeEmojis(p.description) || "").slice(0, 50)}</div>
          <div class="price-row">
            <span class="price">${money(p.price)}</span>
            <span class="stock-tag ${isOut ? "out" : ""}">${isOut ? "Out of Stock" : (isUnlimited ? "In Stock" : "In Stock (" + stockNum + ")")}</span>
          </div>
          <div class="card-actions">
            ${isOut ? `
              <button class="btn btn-outline btn-block" disabled style="opacity:0.5; cursor:not-allowed; grid-column:1/-1;">Out of Stock</button>
            ` : `
              <button class="btn btn-outline add-cart" data-id="${p.id}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                Add to Cart
              </button>
              <button class="btn btn-primary buy-now" data-id="${p.id}">Buy Now</button>
            `}
          </div>
        </div>
      </div>
    `;
  }).join("");

  grid.querySelectorAll(".product-img-wrap, h3").forEach(el => {
    el.closest(".product-card").addEventListener("click", (e) => {
      if (e.target.closest(".card-actions")) return;
      openProductModal(el.closest(".product-card").dataset.id);
    });
  });

  grid.querySelectorAll(".add-cart").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    quickAddToCart(btn.dataset.id);
  }));

  grid.querySelectorAll(".buy-now").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const p = PRODUCTS.find(x => x.id === btn.dataset.id);
    if (p) {
      const isUnlimited = Boolean(p.unlimitedStock);
      const stockNum = Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0));
      if (!isUnlimited && stockNum <= 0) {
        toast("Sorry, this item is out of stock.");
        return;
      }
      buyNowItem = {
        ...p,
        name: removeEmojis(p.name),
        qty: 1,
        color: (p.colors || [])[0] || null,
        deliveryCharge: Number(p.deliveryCharge || 0)
      };
      startCheckout("buyNow");
    }
  }));
}

// ---------- PRODUCT MODAL & GALLERY ----------
let pdGalleryImages = [];
let currentGalleryIdx = 0;

function setupPdGallery(images) {
  pdGalleryImages = (Array.isArray(images) && images.length > 0)
    ? images.filter(Boolean)
    : [getProductImage(activeProduct)];

  if (pdGalleryImages.length === 0) {
    pdGalleryImages = [DEFAULT_PRODUCT_IMAGE];
  }

  currentGalleryIdx = 0;
  renderPdGallerySlide();
}

function renderPdGallerySlide() {
  const mainImg = $("#pdImage");
  if (!mainImg) return;
  const currentSrc = pdGalleryImages[currentGalleryIdx] || DEFAULT_PRODUCT_IMAGE;

  mainImg.src = currentSrc;
  mainImg.onerror = () => { mainImg.src = DEFAULT_PRODUCT_IMAGE; };

  const prevBtn = $("#pdGalleryPrev");
  const nextBtn = $("#pdGalleryNext");
  const dotsWrap = $("#pdGalleryDots");
  const thumbsWrap = $("#pdGalleryThumbnails");

  if (pdGalleryImages.length > 1) {
    if (prevBtn) prevBtn.style.display = "flex";
    if (nextBtn) nextBtn.style.display = "flex";

    if (dotsWrap) {
      dotsWrap.innerHTML = pdGalleryImages.map((_, i) =>
        `<span class="dot-node ${i === currentGalleryIdx ? "active" : ""}" data-idx="${i}"></span>`
      ).join("");
      dotsWrap.querySelectorAll(".dot-node").forEach(d => {
        d.addEventListener("click", () => {
          currentGalleryIdx = Number(d.dataset.idx);
          renderPdGallerySlide();
        });
      });
    }

    if (thumbsWrap) {
      thumbsWrap.innerHTML = pdGalleryImages.map((img, i) =>
        `<img src="${img}" class="thumb-item ${i === currentGalleryIdx ? "active" : ""}" data-idx="${i}" onerror="this.src='${DEFAULT_PRODUCT_IMAGE}'">`
      ).join("");
      thumbsWrap.querySelectorAll(".thumb-item").forEach(t => {
        t.addEventListener("click", () => {
          currentGalleryIdx = Number(t.dataset.idx);
          renderPdGallerySlide();
        });
      });
      thumbsWrap.style.display = "flex";
    }
  } else {
    if (prevBtn) prevBtn.style.display = "none";
    if (nextBtn) nextBtn.style.display = "none";
    if (dotsWrap) dotsWrap.innerHTML = "";
    if (thumbsWrap) thumbsWrap.style.display = "none";
  }
}

if ($("#pdGalleryPrev")) {
  $("#pdGalleryPrev").addEventListener("click", () => {
    if (pdGalleryImages.length > 1) {
      currentGalleryIdx = (currentGalleryIdx - 1 + pdGalleryImages.length) % pdGalleryImages.length;
      renderPdGallerySlide();
    }
  });
}
if ($("#pdGalleryNext")) {
  $("#pdGalleryNext").addEventListener("click", () => {
    if (pdGalleryImages.length > 1) {
      currentGalleryIdx = (currentGalleryIdx + 1) % pdGalleryImages.length;
      renderPdGallerySlide();
    }
  });
}

function openProductModal(id) {
  activeProduct = PRODUCTS.find(p => p.id === id);
  if (!activeProduct) return;

  const isUnlimited = Boolean(activeProduct.unlimitedStock);
  const stockNum = Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0));

  pdQty = (isUnlimited || stockNum > 0) ? 1 : 0;
  pdSelectedColor = (activeProduct.colors || [])[0] || null;

  // Setup Multi-Image Gallery
  const imagesList = (Array.isArray(activeProduct.images) && activeProduct.images.length > 0)
    ? activeProduct.images
    : [getProductImage(activeProduct)];
  setupPdGallery(imagesList);

  $("#pdName").textContent = removeEmojis(activeProduct.name);
  $("#pdPrice").textContent = money(activeProduct.price);
  $("#pdDesc").textContent = removeEmojis(activeProduct.description) || "";
  $("#pdQty").textContent = pdQty;

  // Stock Badge & Button Guards
  const stockBadgeWrap = $("#pdStockBadgeWrap");
  const addCartBtn = $("#pdAddCart");
  const buyNowBtn = $("#pdBuyNow");
  const minusBtn = $("#pdMinus");
  const plusBtn = $("#pdPlus");

  if (!isUnlimited && stockNum <= 0) {
    if (stockBadgeWrap) {
      stockBadgeWrap.innerHTML = `<span class="pill no">Out of Stock (0)</span>`;
    }
    if (addCartBtn) {
      addCartBtn.disabled = true;
      addCartBtn.style.opacity = "0.5";
      addCartBtn.style.cursor = "not-allowed";
    }
    if (buyNowBtn) {
      buyNowBtn.disabled = true;
      buyNowBtn.style.opacity = "0.5";
      buyNowBtn.style.cursor = "not-allowed";
    }
    if (minusBtn) minusBtn.disabled = true;
    if (plusBtn) plusBtn.disabled = true;
  } else {
    if (stockBadgeWrap) {
      if (isUnlimited) {
        stockBadgeWrap.innerHTML = `<span class="pill yes" style="background:#e6f4ea;color:#137333;border:1px solid #ceead6">In Stock</span>`;
      } else if (stockNum <= 3) {
        stockBadgeWrap.innerHTML = `<span class="pill warning" style="background:#fff5eb;color:#b7791f;border:1px solid #fbd38d">Low Stock (${stockNum} left)</span>`;
      } else {
        stockBadgeWrap.innerHTML = `<span class="pill yes">In Stock (${stockNum})</span>`;
      }
    }
    if (addCartBtn) {
      addCartBtn.disabled = false;
      addCartBtn.style.opacity = "1";
      addCartBtn.style.cursor = "pointer";
    }
    if (buyNowBtn) {
      buyNowBtn.disabled = false;
      buyNowBtn.style.opacity = "1";
      buyNowBtn.style.cursor = "pointer";
    }
    if (minusBtn) minusBtn.disabled = false;
    if (plusBtn) plusBtn.disabled = false;
  }

  renderPdOptions();
  updatePdTotal();
  $("#productOverlay").classList.add("open");
}

function renderPdOptions() {
  let html = "";
  if (activeProduct.colors && activeProduct.colors.length) {
    html += `<div class="option-group"><label>Available Colors</label><div class="chip-row" id="colorChips">`;
    html += activeProduct.colors.map(c => `<button class="chip ${c === pdSelectedColor ? "selected" : ""}" data-color="${c}">${removeEmojis(c)}</button>`).join("");
    html += `</div></div>`;
  }
  if (activeProduct.customFields) {
    Object.entries(activeProduct.customFields).forEach(([k, v]) => {
      html += `<div class="option-group"><label>${removeEmojis(k)}</label><div class="chip-row"><span class="chip selected" style="cursor:default">${removeEmojis(v)}</span></div></div>`;
    });
  }
  $("#pdOptions").innerHTML = html;
  document.querySelectorAll("#colorChips .chip").forEach(chip => chip.addEventListener("click", () => {
    pdSelectedColor = chip.dataset.color;
    renderPdOptions();
  }));
}
function updatePdTotal() { $("#pdTotal").textContent = money(activeProduct.price * pdQty); }

if ($("#closeProduct")) $("#closeProduct").addEventListener("click", () => $("#productOverlay").classList.remove("open"));
if ($("#productOverlay")) $("#productOverlay").addEventListener("click", (e) => { if (e.target.id === "productOverlay") e.currentTarget.classList.remove("open"); });

if ($("#pdMinus")) $("#pdMinus").addEventListener("click", () => {
  const isUnlimited = activeProduct ? Boolean(activeProduct.unlimitedStock) : false;
  const stockNum = activeProduct ? Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0)) : 0;
  if (!isUnlimited && stockNum <= 0) return;
  if (pdQty > 1) pdQty--;
  $("#pdQty").textContent = pdQty;
  updatePdTotal();
});

if ($("#pdPlus")) $("#pdPlus").addEventListener("click", () => {
  const isUnlimited = activeProduct ? Boolean(activeProduct.unlimitedStock) : false;
  const stockNum = activeProduct ? Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0)) : 0;
  if (!isUnlimited && stockNum <= 0) return;
  if (!isUnlimited && pdQty >= stockNum) {
    toast(`Only ${stockNum} item(s) available in stock.`);
    return;
  }
  pdQty++;
  $("#pdQty").textContent = pdQty;
  updatePdTotal();
});

if ($("#pdAddCart")) $("#pdAddCart").addEventListener("click", () => {
  if (!activeProduct) return;
  const isUnlimited = Boolean(activeProduct.unlimitedStock);
  const stockNum = Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0));
  if (!isUnlimited && stockNum <= 0) {
    toast("Sorry, this item is out of stock.");
    return;
  }
  const added = addToCart(activeProduct, pdQty, pdSelectedColor);
  if (added) {
    $("#productOverlay").classList.remove("open");
    toast("Added to cart");
  }
});

if ($("#pdBuyNow")) $("#pdBuyNow").addEventListener("click", () => {
  if (!activeProduct) return;
  const isUnlimited = Boolean(activeProduct.unlimitedStock);
  const stockNum = Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0));
  if (!isUnlimited && stockNum <= 0) {
    toast("Sorry, this item is out of stock.");
    return;
  }
  buyNowItem = {
    ...activeProduct,
    name: removeEmojis(activeProduct.name),
    qty: pdQty > 0 ? pdQty : 1,
    color: pdSelectedColor,
    deliveryCharge: Number(activeProduct.deliveryCharge || 0)
  };
  $("#productOverlay").classList.remove("open");
  startCheckout("buyNow");
});

// ---------- CART CALCULATIONS & RENDERING ----------
function saveCart() { localStorage.setItem("blume_cart", JSON.stringify(CART)); renderCartBadge(); }

function addToCart(product, qty, color) {
  if (!product) return false;
  const isUnlimited = Boolean(product.unlimitedStock);
  const stockNum = Number(product.stockQuantity !== undefined ? product.stockQuantity : (product.stock || 0));
  if (!isUnlimited && stockNum <= 0) {
    toast("Sorry, this item is out of stock.");
    return false;
  }

  const key = product.id + "|" + (color || "");
  const existing = CART.find(i => i.key === key);
  const currentInCart = existing ? existing.qty : 0;

  if (!isUnlimited && currentInCart + qty > stockNum) {
    toast(`Cannot add. Maximum available stock is ${stockNum}.`);
    return false;
  }

  const imageSource = getProductImage(product);
  const deliveryCharge = typeof product.deliveryCharge !== "undefined" ? Number(product.deliveryCharge) : 0;
  const validDelCharge = isNaN(deliveryCharge) ? 0 : deliveryCharge;

  if (existing) {
    existing.qty += qty;
    existing.deliveryCharge = validDelCharge;
    existing.price = Number(product.price || 0);
  } else {
    CART.push({
      key,
      id: product.id,
      name: removeEmojis(product.name),
      price: Number(product.price || 0),
      deliveryCharge: validDelCharge,
      imageUrl: imageSource,
      imageBase64: imageSource,
      color,
      qty
    });
  }
  saveCart();
  renderCart();
  return true;
}

function quickAddToCart(id) {
  const p = PRODUCTS.find(x => x.id === id);
  if (p) {
    const added = addToCart(p, 1, (p.colors || [])[0] || null);
    if (added) toast("Added to cart");
  }
}

function renderCartBadge() {
  const count = CART.reduce((s, i) => s + i.qty, 0);
  const badge = $("#cartBadge");
  if (badge) {
    badge.textContent = count;
    badge.style.display = count ? "flex" : "none";
  }
}

function getItemDeliveryCharge(item) {
  if (!item) return 0;
  let fee = Number(item.deliveryCharge);
  if (!isNaN(fee) && fee > 0) {
    return fee;
  }
  const found = PRODUCTS.find(p => p.id === item.id);
  if (found && typeof found.deliveryCharge === "number") {
    return Number(found.deliveryCharge || 0);
  }
  return 0;
}

function cartSubtotal() { return CART.reduce((s, i) => s + Number(i.price || 0) * i.qty, 0); }
function cartDeliveryCharge() {
  if (!CART.length) return 0;
  const fees = CART.map(i => getItemDeliveryCharge(i));
  return Math.max(0, ...fees);
}
function cartTotal() { return cartSubtotal() + cartDeliveryCharge(); }

function renderCart() {
  const wrap = $("#cartItems");
  if (!wrap) return;
  if (!CART.length) {
    wrap.innerHTML = `<div class="cart-empty">Your cart is empty.<br>Start adding products to your order!</div>`;
    if ($("#cartFooter")) $("#cartFooter").style.display = "none";
    return;
  }

  wrap.innerHTML = CART.map(item => {
    const imageSource = getProductImage(item);
    const cleanItemName = removeEmojis(item.name);
    return `
      <div class="cart-item" data-key="${item.key}">
        <img src="${imageSource}" alt="${cleanItemName}">
        <div class="cart-item-info">
          <h4>${cleanItemName}</h4>
          <div class="meta">${item.color ? removeEmojis(item.color) + " · " : ""}${money(item.price)}</div>
          <div class="cart-item-controls">
            <div class="qty-control">
              <button class="dec">−</button><span>${item.qty}</span><button class="inc">+</button>
            </div>
            <a class="remove">Remove</a>
          </div>
        </div>
      </div>
    `;
  }).join("");

  if ($("#cartFooter")) $("#cartFooter").style.display = "block";
  if ($("#cartSubtotal")) $("#cartSubtotal").textContent = money(cartSubtotal());
  if ($("#cartDeliveryCharge")) $("#cartDeliveryCharge").textContent = money(cartDeliveryCharge());
  if ($("#cartTotal")) $("#cartTotal").textContent = money(cartTotal());

  wrap.querySelectorAll(".cart-item").forEach(el => {
    const key = el.dataset.key;
    el.querySelector(".inc").addEventListener("click", () => { changeQty(key, 1); });
    el.querySelector(".dec").addEventListener("click", () => { changeQty(key, -1); });
    el.querySelector(".remove").addEventListener("click", () => { CART = CART.filter(i => i.key !== key); saveCart(); renderCart(); });
  });
}

function changeQty(key, delta) {
  const item = CART.find(i => i.key === key);
  if (!item) return;
  if (delta > 0) {
    const p = PRODUCTS.find(x => x.id === item.id);
    const isUnlimited = p ? Boolean(p.unlimitedStock) : false;
    const stockNum = p ? Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0)) : 9999;
    if (!isUnlimited && item.qty + delta > stockNum) {
      toast(`Maximum available stock reached (${stockNum}).`);
      return;
    }
  }
  item.qty += delta;
  if (item.qty <= 0) CART = CART.filter(i => i.key !== key);
  saveCart(); renderCart();
}

if ($("#cartToggle")) $("#cartToggle").addEventListener("click", () => { $("#cartDrawer").classList.add("open"); $("#drawerOverlay").classList.add("open"); });
if ($("#closeCart")) $("#closeCart").addEventListener("click", closeDrawer);
if ($("#drawerOverlay")) $("#drawerOverlay").addEventListener("click", closeDrawer);
function closeDrawer() { $("#cartDrawer").classList.remove("open"); $("#drawerOverlay").classList.remove("open"); }

// ---------- SEARCH & FILTERS ----------
if ($("#searchToggle")) {
  $("#searchToggle").addEventListener("click", () => {
    const shopEl = document.getElementById("shop");
    if (shopEl) shopEl.scrollIntoView({ behavior: "smooth" });
    setTimeout(() => { if ($("#searchInput")) $("#searchInput").focus(); }, 400);
  });
}
if ($("#searchInput")) $("#searchInput").addEventListener("input", renderProducts);
if ($("#categoryFilter")) $("#categoryFilter").addEventListener("change", renderProducts);
if ($("#sortFilter")) $("#sortFilter").addEventListener("change", renderProducts);

// ---------- MOBILE MENU ----------
if ($("#hamburger")) $("#hamburger").addEventListener("click", () => $("#mobileMenu").classList.toggle("open"));
document.querySelectorAll("#mobileMenu a").forEach(a => a.addEventListener("click", () => $("#mobileMenu").classList.remove("open")));

// ---------- CHECKOUT ----------
function getCheckoutItems() {
  if (checkoutMode === "buyNow" && buyNowItem) {
    return [{
      id: buyNowItem.id,
      name: removeEmojis(buyNowItem.name),
      price: Number(buyNowItem.price || 0),
      qty: buyNowItem.qty,
      color: buyNowItem.color,
      deliveryCharge: getItemDeliveryCharge(buyNowItem)
    }];
  }
  return CART.map(i => ({
    id: i.id,
    name: removeEmojis(i.name),
    price: Number(i.price || 0),
    qty: i.qty,
    color: i.color,
    deliveryCharge: getItemDeliveryCharge(i)
  }));
}

function getCheckoutSubtotal() { return getCheckoutItems().reduce((s, i) => s + i.price * i.qty, 0); }
function getCheckoutDeliveryCharge() {
  const items = getCheckoutItems();
  if (!items.length) return 0;
  return Math.max(0, ...items.map(i => getItemDeliveryCharge(i)));
}
function getCheckoutTotal() { return getCheckoutSubtotal() + getCheckoutDeliveryCharge(); }

function startCheckout(mode) {
  checkoutMode = mode;
  if (mode === "cart" && !CART.length) { toast("Your cart is empty"); return; }

  const items = getCheckoutItems();
  for (const item of items) {
    const p = PRODUCTS.find(x => x.id === item.id);
    if (p) {
      const isUnlimited = Boolean(p.unlimitedStock);
      const stockNum = Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0));
      if (!isUnlimited) {
        if (stockNum <= 0) {
          toast(`"${item.name}" is currently out of stock.`);
          return;
        }
        if (item.qty > stockNum) {
          toast(`Cannot checkout. Only ${stockNum} available for "${item.name}".`);
          return;
        }
      }
    }
  }

  currentStep = 1;
  showStep(1);
  renderOrderLines();
  closeDrawer();
  $("#checkoutOverlay").classList.add("open");
}

if ($("#checkoutBtn")) $("#checkoutBtn").addEventListener("click", () => startCheckout("cart"));
if ($("#closeCheckout")) $("#closeCheckout").addEventListener("click", () => $("#checkoutOverlay").classList.remove("open"));

function renderOrderLines() {
  const items = getCheckoutItems();
  const subtotal = getCheckoutSubtotal();
  const delivery = getCheckoutDeliveryCharge();
  const total = getCheckoutTotal();

  let html = items.map(i => `
    <div class="order-line"><span>${removeEmojis(i.name)} ${i.color ? "(" + removeEmojis(i.color) + ")" : ""} × ${i.qty}</span><span>${money(i.price * i.qty)}</span></div>
  `).join("");

  html += `<div class="order-line" style="margin-top:12px; border-top:1px solid var(--beige); padding-top:8px;"><span>Subtotal</span><span>${money(subtotal)}</span></div>`;
  html += `<div class="order-line"><span>Delivery Charge</span><span>${money(delivery)}</span></div>`;
  html += `<div class="order-line" style="font-weight:700; color:var(--rose-deep); font-size:1.05rem;"><span>Total</span><span>${money(total)}</span></div>`;

  $("#checkoutOrderLines").innerHTML = html;
}

// ============================================================
// CUSTOMER SAVED DETAILS & AUTHENTICATION
// ============================================================

function syncProfileStateToUI() {
  const profile = CURRENT_CUSTOMER_PROFILE;

  // 1. Checkout Step 2 view sync
  const savedGreeting = $("#savedProfileGreeting");
  const savedLoggedInCard = $("#savedLoggedInCard");
  const savedAuthBox = $("#savedAuthPromptBox");

  if (profile) {
    if (savedGreeting) savedGreeting.textContent = `${profile.fullName || "Valued Customer"} (${profile.mobile || ""})`;
    if (savedLoggedInCard) savedLoggedInCard.style.display = "flex";
    if (savedAuthBox) savedAuthBox.style.display = "none";

    // If currently on "saved" choice, prefill checkout inputs
    if (checkoutOptionMode === "saved") {
      autofillCheckoutFromProfile(profile);
    }
  } else {
    if (savedLoggedInCard) savedLoggedInCard.style.display = "none";
    if (savedAuthBox) savedAuthBox.style.display = "block";
  }

  // 2. Profile modal view sync
  const sessionText = $("#profileSessionText");
  const loggedInHeader = $("#profileLoggedInHeader");
  const formAccess = $("#formAccessProfile");
  const formSave = $("#formSaveProfile");
  const tabsBar = $("#profileTabsBar");
  const pfPinSection = $("#pfPinSection");
  const pfPinHeader = $("#pfPinHeader");

  if (profile) {
    if (sessionText) sessionText.textContent = `Signed in: ${profile.fullName || "User"} (${profile.mobile || ""})`;
    if (loggedInHeader) loggedInHeader.style.display = "flex";
    if (tabsBar) tabsBar.style.display = "none";
    if (formAccess) formAccess.style.display = "none";
    if (formSave) formSave.style.display = "block";

    if ($("#pfName")) $("#pfName").value = profile.fullName || "";
    if ($("#pfMobile")) $("#pfMobile").value = profile.mobile || "";
    if ($("#pfWhatsapp")) $("#pfWhatsapp").value = profile.whatsapp || "";
    if ($("#pfEmail")) $("#pfEmail").value = profile.email || "";

    const a = profile.address || {};
    if ($("#pfHouse")) $("#pfHouse").value = a.house || "";
    if ($("#pfStreet")) $("#pfStreet").value = a.street || "";
    if ($("#pfArea")) $("#pfArea").value = a.area || "";
    if ($("#pfCity")) $("#pfCity").value = a.city || "";
    if ($("#pfDistrict")) $("#pfDistrict").value = a.district || "";
    if ($("#pfState")) $("#pfState").value = a.state || "";
    if ($("#pfPincode")) $("#pfPincode").value = a.pincode || "";

    if (pfPinHeader) pfPinHeader.textContent = "Change Password / Security PIN (Optional — leave blank to keep current)";
    if ($("#pfPin")) { $("#pfPin").required = false; $("#pfPin").value = ""; }
    if ($("#pfConfirmPin")) { $("#pfConfirmPin").required = false; $("#pfConfirmPin").value = ""; }
    if ($("#btnSubmitSaveProfile")) $("#btnSubmitSaveProfile").textContent = "Update Details";
  } else {
    if (loggedInHeader) loggedInHeader.style.display = "none";
    if (tabsBar) tabsBar.style.display = "flex";
    if (pfPinHeader) pfPinHeader.textContent = "Account Password / Security PIN (min 4 characters) *";
    if ($("#pfPin")) $("#pfPin").required = true;
    if ($("#pfConfirmPin")) $("#pfConfirmPin").required = true;
    if ($("#btnSubmitSaveProfile")) $("#btnSubmitSaveProfile").textContent = "Save Details";
  }
}

function autofillCheckoutFromProfile(p) {
  if (!p) return;
  if ($("#custName")) $("#custName").value = p.fullName || "";
  if ($("#custMobile")) $("#custMobile").value = p.mobile || "";
  if ($("#custWhatsapp")) $("#custWhatsapp").value = p.whatsapp || "";
  if ($("#custEmail")) $("#custEmail").value = p.email || "";

  const a = p.address || {};
  if ($("#addrHouse")) $("#addrHouse").value = a.house || "";
  if ($("#addrStreet")) $("#addrStreet").value = a.street || "";
  if ($("#addrArea")) $("#addrArea").value = a.area || "";
  if ($("#addrCity")) $("#addrCity").value = a.city || "";
  if ($("#addrDistrict")) $("#addrDistrict").value = a.district || "";
  if ($("#addrState")) $("#addrState").value = a.state || "";
  if ($("#addrPincode")) $("#addrPincode").value = a.pincode || "";
  if ($("#findOrderMobileInput") && p.mobile) $("#findOrderMobileInput").value = p.mobile;
}

function showProfileAlert(msg, isError = true) {
  const el = $("#profileAlertMsg");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  el.style.background = isError ? "#fde8e8" : "#def7ec";
  el.style.color = isError ? "#9b1c1c" : "#03543f";
  el.style.border = isError ? "1px solid #f8b4b4" : "1px solid #84e1bc";
}

function clearProfileAlert() {
  const el = $("#profileAlertMsg");
  if (el) el.style.display = "none";
}

// Initial sync of cached customer profile
syncProfileStateToUI();

// Setup eye toggles
document.querySelectorAll(".pin-toggle-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target;
    const input = document.getElementById(targetId);
    if (!input) return;
    if (input.type === "password") {
      input.type = "text";
      btn.style.opacity = "1";
    } else {
      input.type = "password";
      btn.style.opacity = "0.6";
    }
  });
});

// "Same as Mobile" checkbox synchronization
if ($("#chkSameAsMobile")) {
  $("#chkSameAsMobile").addEventListener("change", (e) => {
    if (e.target.checked && $("#custMobile")) {
      $("#custWhatsapp").value = $("#custMobile").value;
    }
  });
}
if ($("#custMobile")) {
  $("#custMobile").addEventListener("input", (e) => {
    if ($("#chkSameAsMobile")?.checked && $("#custWhatsapp")) {
      $("#custWhatsapp").value = e.target.value;
    }
  });
}
if ($("#chkPfSameAsMobile")) {
  $("#chkPfSameAsMobile").addEventListener("change", (e) => {
    if (e.target.checked && $("#pfMobile")) {
      $("#pfWhatsapp").value = $("#pfMobile").value;
    }
  });
}
if ($("#pfMobile")) {
  $("#pfMobile").addEventListener("input", (e) => {
    if ($("#chkPfSameAsMobile")?.checked && $("#pfWhatsapp")) {
      $("#pfWhatsapp").value = e.target.value;
    }
  });
}
if ($("#chkGuestSaveProfile")) {
  $("#chkGuestSaveProfile").addEventListener("change", (e) => {
    const fields = $("#guestPinFields");
    if (fields) fields.style.display = e.target.checked ? "block" : "none";
  });
}

// Modal open/close and tab switches
function openCustomerProfileModal(defaultTab = "access") {
  clearProfileAlert();
  if (CURRENT_CUSTOMER_PROFILE) {
    syncProfileStateToUI();
  } else {
    switchProfileTab(defaultTab);
  }
  $("#customerProfileModalOverlay")?.classList.add("open");
}

function switchProfileTab(tab) {
  clearProfileAlert();
  const btnAcc = $("#tabBtnAccessProfile");
  const btnCre = $("#tabBtnCreateProfile");
  const formAcc = $("#formAccessProfile");
  const formSave = $("#formSaveProfile");

  if (tab === "access") {
    btnAcc?.classList.add("active");
    btnAcc?.style.setProperty("background", "var(--dusty-rose)", "important");
    btnAcc?.style.setProperty("color", "#fff", "important");
    btnCre?.classList.remove("active");
    btnCre?.style.setProperty("background", "var(--ivory)", "important");
    btnCre?.style.setProperty("color", "var(--brown)", "important");
    if (formAcc) formAcc.style.display = "block";
    if (formSave) formSave.style.display = "none";
  } else {
    btnCre?.classList.add("active");
    btnCre?.style.setProperty("background", "var(--dusty-rose)", "important");
    btnCre?.style.setProperty("color", "#fff", "important");
    btnAcc?.classList.remove("active");
    btnAcc?.style.setProperty("background", "var(--ivory)", "important");
    btnAcc?.style.setProperty("color", "var(--brown)", "important");
    if (formAcc) formAcc.style.display = "none";
    if (formSave) formSave.style.display = "block";
  }
}

$("#tabBtnAccessProfile")?.addEventListener("click", () => switchProfileTab("access"));
$("#tabBtnCreateProfile")?.addEventListener("click", () => switchProfileTab("create"));

$("#profileToggle")?.addEventListener("click", () => openCustomerProfileModal("access"));
$("#navSavedDetails")?.addEventListener("click", (e) => { e.preventDefault(); openCustomerProfileModal("access"); });
$("#mobileSavedDetails")?.addEventListener("click", (e) => { e.preventDefault(); $("#mobileMenu")?.classList.remove("open"); openCustomerProfileModal("access"); });
$("#bannerManageDetailsBtn")?.addEventListener("click", () => openCustomerProfileModal("access"));
$("#closeCustomerProfile")?.addEventListener("click", () => $("#customerProfileModalOverlay")?.classList.remove("open"));
$("#btnCancelProfile")?.addEventListener("click", () => $("#customerProfileModalOverlay")?.classList.remove("open"));
$("#coForgotPinHelp")?.addEventListener("click", (e) => {
  e.preventDefault();
  openCustomerProfileModal("create");
});

async function authenticateCustomer(mobile, password) {
  const cleanPhone = String(mobile || "").replace(/\D/g, "");
  if (!cleanPhone || cleanPhone.length !== 10) {
    throw new Error("Please enter a valid 10-digit mobile number.");
  }
  const cleanPwd = String(password || "").trim();
  if (!cleanPwd || cleanPwd.length < 4 || cleanPwd.length > 32) {
    throw new Error("Password / PIN must be between 4 and 32 characters.");
  }

  const regKey = await deriveRegistryKey(cleanPhone);
  const vaultKey = await deriveVaultKey(cleanPhone, cleanPwd);

  let vaultData = null;
  let regFound = false;

  // 1. Look up blind registry record in Firestore (proves an account exists for this mobile)
  try {
    const regSnap = await getDoc(doc(db, "customer_registry", regKey));
    if (regSnap.exists()) {
      regFound = true;
    }
  } catch (err) {
    console.warn("Registry lookup notice:", err.message);
  }

  // 2. If registry exists, retrieve the customer's vault document using the exact vaultKey
  if (regFound) {
    try {
      const vSnap = await getDoc(doc(db, "customer_vault", vaultKey));
      if (vSnap.exists()) {
        vaultData = vSnap.data();
      } else {
        // Registry confirmed account exists, but vaultKey did not match: wrong password
        throw new Error("Incorrect Password / Security PIN. Please verify your credentials and try again.");
      }
    } catch (err) {
      if (err.message.includes("Incorrect Password")) throw err;
      console.warn("Vault lookup notice:", err.message);
    }
  }

  // 3. Backward-compatibility auto-migration for legacy customer_profiles
  if (!vaultData && !regFound) {
    try {
      const legSnap = await getDoc(doc(db, "customer_profiles", cleanPhone));
      if (legSnap.exists()) {
        const legData = legSnap.data();
        const inputHash = await hashCustomerPin(cleanPhone, cleanPwd);
        if (legData.pinHash && legData.pinHash !== inputHash) {
          throw new Error("Incorrect Password / Security PIN. Please verify your credentials and try again.");
        }
        vaultData = {
          fullName: legData.fullName || "",
          mobile: cleanPhone,
          whatsapp: legData.whatsapp || cleanPhone,
          email: legData.email || "",
          address: legData.address || {}
        };
        // Transparently upgrade legacy profile to secure zero-knowledge vault
        try {
          await setDoc(doc(db, "customer_registry", regKey), { registered: true, updatedAt: serverTimestamp() }, { merge: true });
          await setDoc(doc(db, "customer_vault", vaultKey), { ...vaultData, updatedAt: serverTimestamp() }, { merge: true });
        } catch (migErr) {
          console.warn("Auto-migration to vault notice:", migErr.message);
        }
      }
    } catch (err) {
      if (err.message.includes("Incorrect Password")) throw err;
      console.warn("Legacy profile check notice:", err.message);
    }
  }

  // 4. Device fallback if network or Firestore issue
  if (!vaultData) {
    const local = localStorage.getItem("blume_saved_profile_" + cleanPhone);
    if (local) {
      try {
        const parsed = JSON.parse(local);
        const inputHash = await hashCustomerPin(cleanPhone, cleanPwd);
        if (!parsed.pinHash || parsed.pinHash === inputHash) {
          vaultData = parsed;
        } else {
          throw new Error("Incorrect Password / Security PIN. Please verify your credentials and try again.");
        }
      } catch (e) {
        if (e.message.includes("Incorrect Password")) throw e;
      }
    }
  }

  if (!vaultData) {
    throw new Error("No saved customer details found for this mobile number. You can enter details manually or create a new account.");
  }

  CURRENT_CUSTOMER_VAULT_KEY = vaultKey;
  CURRENT_CUSTOMER_REG_KEY = regKey;
  const profile = { mobile: cleanPhone, ...vaultData };
  CURRENT_CUSTOMER_PROFILE = profile;
  sessionStorage.setItem("blume_saved_profile", JSON.stringify(profile));
  sessionStorage.setItem("blume_vault_key", vaultKey);
  sessionStorage.setItem("blume_reg_key", regKey);
  syncProfileStateToUI();
  return profile;
}

async function persistCustomerVaultProfile({ fullName, mobile, whatsapp, email, address, password = null }) {
  const cleanPhone = String(mobile || "").replace(/\D/g, "");
  if (!cleanPhone || cleanPhone.length !== 10) {
    throw new Error("Please enter a valid 10-digit Mobile Number.");
  }
  if (!fullName || !fullName.trim()) {
    throw new Error("Please enter your Full Name.");
  }

  const regKey = await deriveRegistryKey(cleanPhone);
  let vaultKey = CURRENT_CUSTOMER_VAULT_KEY;

  if (password && password.trim()) {
    vaultKey = await deriveVaultKey(cleanPhone, password.trim());
  } else if (!vaultKey) {
    vaultKey = sessionStorage.getItem("blume_vault_key");
  }

  if (!vaultKey) {
    throw new Error("Password / PIN is required to secure your customer account.");
  }

  const profilePayload = {
    fullName: fullName.trim(),
    mobile: cleanPhone,
    whatsapp: String(whatsapp || cleanPhone).replace(/\D/g, ""),
    email: (email || "").trim(),
    address: {
      house: (address?.house || "").trim(),
      street: (address?.street || "").trim(),
      area: (address?.area || "").trim(),
      city: (address?.city || "").trim(),
      district: (address?.district || "").trim(),
      state: (address?.state || "").trim(),
      pincode: (address?.pincode || "").trim()
    },
    updatedAt: serverTimestamp()
  };

  // 1. Blind registry existence entry (zero PII)
  await setDoc(doc(db, "customer_registry", regKey), {
    registered: true,
    updatedAt: serverTimestamp()
  }, { merge: true });

  // 2. Blind customer vault entry (zero-knowledge keyed)
  await setDoc(doc(db, "customer_vault", vaultKey), profilePayload, { merge: true });

  // 3. Local state and session sync
  CURRENT_CUSTOMER_VAULT_KEY = vaultKey;
  CURRENT_CUSTOMER_REG_KEY = regKey;
  CURRENT_CUSTOMER_PROFILE = { ...profilePayload };
  sessionStorage.setItem("blume_saved_profile", JSON.stringify(CURRENT_CUSTOMER_PROFILE));
  sessionStorage.setItem("blume_vault_key", vaultKey);
  sessionStorage.setItem("blume_reg_key", regKey);
  syncProfileStateToUI();

  return profilePayload;
}

if ($("#formAccessProfile")) {
  $("#formAccessProfile").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearProfileAlert();
    const btn = $("#btnSubmitAccess");
    const mob = $("#accMobile")?.value.trim();
    const pin = $("#accPin")?.value.trim();

    if (btn) { btn.disabled = true; btn.textContent = "Verifying..."; }
    try {
      const profile = await authenticateCustomer(mob, pin);
      showProfileAlert(`Welcome back, ${profile.fullName}! Your saved details have been unlocked.`, false);
      toast(`Welcome back, ${profile.fullName}!`);
      setTimeout(() => {
        $("#customerProfileModalOverlay")?.classList.remove("open");
      }, 1000);
    } catch (err) {
      console.error("Profile access error:", err);
      showProfileAlert(err.message, true);
      toast(err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Unlock My Details"; }
    }
  });
}

if ($("#btnCoUnlockSaved")) {
  $("#btnCoUnlockSaved").addEventListener("click", async () => {
    const btn = $("#btnCoUnlockSaved");
    const mob = $("#coAuthMobile")?.value.trim();
    const pin = $("#coAuthPin")?.value.trim();

    if (btn) { btn.disabled = true; btn.textContent = "Unlocking..."; }
    try {
      const profile = await authenticateCustomer(mob, pin);
      autofillCheckoutFromProfile(profile);
      toast(`Details loaded for ${profile.fullName}`);
    } catch (err) {
      console.error("Checkout profile unlock error:", err);
      alert(err.message);
      toast(err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Unlock & Load Details"; }
    }
  });
}

// Sign Out
function customerSignOut() {
  sessionStorage.removeItem("blume_saved_profile");
  sessionStorage.removeItem("blume_vault_key");
  sessionStorage.removeItem("blume_reg_key");
  CURRENT_CUSTOMER_PROFILE = null;
  CURRENT_CUSTOMER_VAULT_KEY = null;
  CURRENT_CUSTOMER_REG_KEY = null;
  syncProfileStateToUI();
  toast("Signed out of customer profile.");
}
$("#btnProfileSignOut")?.addEventListener("click", customerSignOut);
$("#btnCoSignOut")?.addEventListener("click", customerSignOut);

// Save or Update Customer Profile
if ($("#formSaveProfile")) {
  $("#formSaveProfile").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearProfileAlert();

    const name = $("#pfName")?.value.trim();
    const mobile = $("#pfMobile")?.value.trim().replace(/\D/g, "");
    const whatsapp = $("#pfWhatsapp")?.value.trim().replace(/\D/g, "");
    const email = $("#pfEmail")?.value.trim() || "";
    const house = $("#pfHouse")?.value.trim();
    const street = $("#pfStreet")?.value.trim();
    const area = $("#pfArea")?.value.trim();
    const city = $("#pfCity")?.value.trim();
    const district = $("#pfDistrict")?.value.trim();
    const state = $("#pfState")?.value.trim();
    const pincode = $("#pfPincode")?.value.trim();
    const pin = $("#pfPin")?.value.trim();
    const confirmPin = $("#pfConfirmPin")?.value.trim();

    if (!name) { showProfileAlert("Please enter your Full Name."); return; }
    if (!mobile || mobile.length !== 10) { showProfileAlert("Please enter a valid 10-digit Mobile Number."); return; }
    if (!whatsapp || whatsapp.length !== 10) { showProfileAlert("Please enter a valid 10-digit WhatsApp Number."); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showProfileAlert("Please enter a valid email address."); return; }
    if (!house || !street || !area || !city || !district || !state) { showProfileAlert("Please complete all required delivery address fields."); return; }
    if (!pincode || pincode.length !== 6 || !/^\d+$/.test(pincode)) { showProfileAlert("Please enter a valid 6-digit Pincode."); return; }

    const isExisting = Boolean(CURRENT_CUSTOMER_PROFILE && CURRENT_CUSTOMER_PROFILE.mobile === mobile);
    if (!isExisting || pin) {
      if (!pin || pin.length < 4 || pin.length > 32) {
        showProfileAlert("Password / Security PIN must be between 4 and 32 characters.");
        return;
      }
      if (pin !== confirmPin) {
        showProfileAlert("Password / Security PIN and Confirm do not match.");
        return;
      }
    }

    const btn = $("#btnSubmitSaveProfile");
    if (btn) { btn.disabled = true; btn.textContent = "Saving Details..."; }

    try {
      await persistCustomerVaultProfile({
        fullName: name,
        mobile,
        whatsapp,
        email,
        address: { house, street, area, city, district, state, pincode },
        password: pin || null
      });

      showProfileAlert("Your delivery details have been saved securely in the database!", false);
      toast("Details saved successfully!");
      setTimeout(() => {
        $("#customerProfileModalOverlay")?.classList.remove("open");
      }, 1200);

    } catch (err) {
      console.error("Save profile error:", err);
      showProfileAlert("Failed to save details: " + err.message, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = CURRENT_CUSTOMER_PROFILE ? "Update Details" : "Save Details"; }
    }
  });
}

// Checkout Step 2 option toggles
if ($("#btnChoiceSaved")) {
  $("#btnChoiceSaved").addEventListener("click", () => {
    checkoutOptionMode = "saved";
    $("#btnChoiceSaved")?.classList.add("active");
    $("#btnChoiceSaved")?.style.setProperty("background", "var(--dusty-rose)", "important");
    $("#btnChoiceSaved")?.style.setProperty("color", "#fff", "important");
    $("#btnChoiceSaved")?.style.setProperty("border-color", "var(--dusty-rose)", "important");

    $("#btnChoiceManual")?.classList.remove("active");
    $("#btnChoiceManual")?.style.setProperty("background", "var(--white)", "important");
    $("#btnChoiceManual")?.style.setProperty("color", "var(--brown)", "important");
    $("#btnChoiceManual")?.style.setProperty("border-color", "var(--beige)", "important");

    const vSaved = $("#viewSavedDetails");
    const vManual = $("#viewManualDetails");
    const gWrap = $("#guestSaveProfileWrap");
    if (vSaved) vSaved.style.display = "block";
    if (vManual) vManual.style.display = "none";
    if (gWrap) gWrap.style.display = "none";

    if (CURRENT_CUSTOMER_PROFILE) {
      autofillCheckoutFromProfile(CURRENT_CUSTOMER_PROFILE);
    }
  });
}

if ($("#btnChoiceManual")) {
  $("#btnChoiceManual").addEventListener("click", () => {
    checkoutOptionMode = "manual";
    $("#btnChoiceManual")?.classList.add("active");
    $("#btnChoiceManual")?.style.setProperty("background", "var(--dusty-rose)", "important");
    $("#btnChoiceManual")?.style.setProperty("color", "#fff", "important");
    $("#btnChoiceManual")?.style.setProperty("border-color", "var(--dusty-rose)", "important");

    $("#btnChoiceSaved")?.classList.remove("active");
    $("#btnChoiceSaved")?.style.setProperty("background", "var(--white)", "important");
    $("#btnChoiceSaved")?.style.setProperty("color", "var(--brown)", "important");
    $("#btnChoiceSaved")?.style.setProperty("border-color", "var(--beige)", "important");

    const vSaved = $("#viewSavedDetails");
    const vManual = $("#viewManualDetails");
    const gWrap = $("#guestSaveProfileWrap");
    if (vSaved) vSaved.style.display = "none";
    if (vManual) vManual.style.display = "block";
    if (gWrap) gWrap.style.display = "block";
  });
}

let cachedUpiQrData = null;

async function getOrFetchUpiQr() {
  if (cachedUpiQrData && cachedUpiQrData.imageBase64) {
    return cachedUpiQrData;
  }
  try {
    const qrSnap = await getDoc(doc(db, "settings", "upi_qr"));
    if (qrSnap.exists() && qrSnap.data()?.imageBase64) {
      cachedUpiQrData = qrSnap.data();
      return cachedUpiQrData;
    }
  } catch (e) {
    console.warn("Could not fetch settings/upi_qr:", e.message);
  }
  if (SETTINGS.upiQrImageUrl) {
    return { imageBase64: SETTINGS.upiQrImageUrl };
  }
  return null;
}

// Client-side compression for Payment Screenshots to fit within Firestore's 1MB document limit
async function compressScreenshotForFirestore(file) {
  return new Promise((resolve, reject) => {
    const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!file || !validTypes.includes(file.type.toLowerCase())) {
      return reject(new Error("Please upload a valid image file (JPG, PNG, or WebP)."));
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read screenshot file data."));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Unable to parse screenshot image."));
      img.onload = () => {
        // High quality scaling: max dimension 1000px.
        // For a typical phone screen (1080x2400), this resizes to 450x1000, which keeps UTR numbers, amounts, and bank reference lines completely sharp and legible.
        const MAX = 1000;
        let w = img.width;
        let h = img.height;
        if (w > h && w > MAX) {
          h = Math.round((h * MAX) / w);
          w = MAX;
        } else if (h > MAX) {
          w = Math.round((w * MAX) / h);
          h = MAX;
        }

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);

        // JPEG at 0.78 quality preserves high fidelity text while keeping file size ~100KB - 220KB
        let dataUrl = canvas.toDataURL("image/jpeg", 0.78);
        let head = "data:image/jpeg;base64,";
        let b64 = dataUrl.startsWith(head) ? dataUrl.slice(head.length) : dataUrl;
        let byteSize = Math.round((b64.length * 3) / 4);

        // Second pass: if byteSize > 700KB, reduce quality to 0.68 and resize
        if (byteSize > 700000) {
          const canvas2 = document.createElement("canvas");
          const w2 = Math.round(w * 0.8);
          const h2 = Math.round(h * 0.8);
          canvas2.width = w2;
          canvas2.height = h2;
          const ctx2 = canvas2.getContext("2d");
          ctx2.imageSmoothingEnabled = true;
          ctx2.imageSmoothingQuality = "high";
          ctx2.drawImage(img, 0, 0, w2, h2);
          dataUrl = canvas2.toDataURL("image/jpeg", 0.68);
          b64 = dataUrl.startsWith(head) ? dataUrl.slice(head.length) : dataUrl;
          byteSize = Math.round((b64.length * 3) / 4);
          w = w2;
          h = h2;
        }

        // Safe Firestore document limit validation (< 800 KB safe ceiling)
        if (byteSize > 800000) {
          return reject(new Error("Screenshot exceeds safe database size (800KB). Please crop unnecessary borders and try again."));
        }

        resolve({
          dataUrl,
          byteSize,
          mimeType: "image/jpeg",
          width: w,
          height: h
        });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

let currentUpiScreenshotDocId = null;
let currentUpiScreenshotDataUrl = null;
let currentUpiScreenshotName = null;
let currentCheckoutOrderId = null;
let isUploadingStepScreenshot = false;

async function refreshUpiStepUI() {
  const qrImg = $("#customerUpiQrImg");
  const missingAlert = $("#upiMissingQrAlert");
  const qrWrap = $("#upiQrContentWrap");
  const downloadBtn = $("#btnDownloadUpiQr");
  const fileInput = $("#upiStepScreenshotFile");
  const submitBtn = $("#btnSubmitUpiOrder");
  const totalDisplay = $("#upiTotalDisplay");
  const recipientDisplay = $("#upiRecipientNameDisplay");

  const total = getCheckoutTotal();
  if (totalDisplay) totalDisplay.textContent = money(total);
  if (recipientDisplay) recipientDisplay.textContent = SETTINGS.businessName || "Blume Arts";

  const qrData = await getOrFetchUpiQr();
  const configuredQr = qrData?.imageBase64 || "";

  if (configuredQr) {
    if (missingAlert) missingAlert.style.display = "none";
    if (qrWrap) qrWrap.style.display = "block";
    if (qrImg) qrImg.src = configuredQr;
    if (downloadBtn) downloadBtn.disabled = false;
    if (fileInput) fileInput.disabled = false;

    if (submitBtn) {
      if (currentUpiScreenshotDocId) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit Order & Open WhatsApp";
      } else {
        submitBtn.disabled = true;
        submitBtn.textContent = "Upload Screenshot Above to Submit";
      }
    }
  } else {
    // Missing QR Code: display clear error and disable submission
    if (missingAlert) missingAlert.style.display = "block";
    if (qrWrap) qrWrap.style.display = "none";
    if (downloadBtn) downloadBtn.disabled = true;
    if (fileInput) fileInput.disabled = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "UPI Payment Unavailable";
    }
  }
}

async function downloadUpiQrImage() {
  const qrData = await getOrFetchUpiQr();
  const qrUrl = qrData?.imageBase64 || "";
  if (!qrUrl) {
    toast("No UPI QR code configured.");
    return;
  }
  const filename = "UPI-Payment-QR.png";

  try {
    toast("Downloading QR code...");
    let blob;
    if (qrUrl.startsWith("data:")) {
      const parts = qrUrl.split(",");
      const mimeMatch = parts[0].match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : "image/png";
      const bstr = atob(parts[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      blob = new Blob([u8arr], { type: mime });
    } else {
      const res = await fetch(qrUrl, { mode: "cors" });
      if (!res.ok) throw new Error("Network response error " + res.status);
      blob = await res.blob();
    }

    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
    toast("QR code downloaded!");
  } catch (err) {
    console.warn("Direct blob download failed, falling back to direct link:", err);
    const link = document.createElement("a");
    link.href = qrUrl;
    link.target = "_blank";
    link.download = filename;
    link.click();
  }
}

function setupPaymentMethodControls() {
  const codCard = $("#cardMethodCod");
  const upiCard = $("#cardMethodUpi");
  const upiPanel = $("#upiPaymentPanel");
  const nextBtn = $("#nextStep");

  function setMethod(method) {
    selectedPaymentMethod = method;
    if (method === "UPI") {
      upiCard?.classList.add("active");
      upiCard?.style.setProperty("background", "var(--ivory)", "important");
      upiCard?.style.setProperty("border-color", "var(--dusty-rose)", "important");

      codCard?.classList.remove("active");
      codCard?.style.setProperty("background", "var(--white)", "important");
      codCard?.style.setProperty("border-color", "var(--beige)", "important");

      const upiRadio = $("#cardMethodUpi input");
      if (upiRadio) upiRadio.checked = true;
      if (upiPanel) upiPanel.style.display = "block";
      if (nextBtn && currentStep === 5) {
        nextBtn.style.display = "none";
      }
      refreshUpiStepUI();
    } else {
      codCard?.classList.add("active");
      codCard?.style.setProperty("background", "var(--ivory)", "important");
      codCard?.style.setProperty("border-color", "var(--dusty-rose)", "important");

      upiCard?.classList.remove("active");
      upiCard?.style.setProperty("background", "var(--white)", "important");
      upiCard?.style.setProperty("border-color", "var(--beige)", "important");

      const codRadio = $("#cardMethodCod input");
      if (codRadio) codRadio.checked = true;
      if (upiPanel) upiPanel.style.display = "none";
      if (nextBtn && currentStep === 5) {
        nextBtn.style.display = "block";
        nextBtn.textContent = "Confirm Order (Cash on Delivery)";
      }
    }
  }

  codCard?.addEventListener("click", () => setMethod("COD"));
  upiCard?.addEventListener("click", () => setMethod("UPI"));

  document.querySelectorAll('input[name="paymentMethodRadio"]').forEach(r => {
    r.addEventListener("change", (e) => setMethod(e.target.value));
  });

  setMethod(selectedPaymentMethod);
}

function setupStepScreenshotControls() {
  const fileInput = $("#upiStepScreenshotFile");
  const previewWrap = $("#upiStepScreenshotPreviewWrap");
  const previewImg = $("#upiStepScreenshotPreview");
  const removeBtn = $("#btnRemoveUpiStepScreenshot");
  const progressBar = $("#upiStepUploadProgressBar");
  const progressFill = $("#upiStepUploadProgressFill");
  const statusMsg = $("#upiStepUploadStatus");
  const stateBadge = $("#upiScreenshotStateBadge");
  const submitBtn = $("#btnSubmitUpiOrder");

  function resetScreenshotUI() {
    currentUpiScreenshotDocId = null;
    currentUpiScreenshotDataUrl = null;
    currentUpiScreenshotName = null;
    if (fileInput) fileInput.value = "";
    if (previewWrap) previewWrap.style.display = "none";
    if (previewImg) previewImg.src = "";
    if (progressBar) progressBar.style.display = "none";
    if (statusMsg) {
      statusMsg.style.display = "none";
      statusMsg.textContent = "";
    }
    if (stateBadge) {
      stateBadge.textContent = "Required";
      stateBadge.className = "payment-badge";
      stateBadge.style.background = "";
      stateBadge.style.color = "";
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Upload Screenshot Above to Submit";
    }
  }

  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      resetScreenshotUI();
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) {
        resetScreenshotUI();
        return;
      }

      const validTypes = ["image/jpeg", "image/png", "image/webp"];
      if (!validTypes.includes(file.type)) {
        if (statusMsg) {
          statusMsg.style.display = "block";
          statusMsg.style.background = "#fde8e8";
          statusMsg.style.color = "#9b1c1c";
          statusMsg.style.border = "1px solid #f8b4b4";
          statusMsg.textContent = "Please select a valid image file (JPG, PNG, or WebP).";
        }
        resetScreenshotUI();
        return;
      }

      if (file.size > 15 * 1024 * 1024) {
        if (statusMsg) {
          statusMsg.style.display = "block";
          statusMsg.style.background = "#fde8e8";
          statusMsg.style.color = "#9b1c1c";
          statusMsg.style.border = "1px solid #f8b4b4";
          statusMsg.textContent = "Screenshot exceeds 15MB limit. Please choose a smaller image.";
        }
        resetScreenshotUI();
        return;
      }

      // Show local preview immediately
      const reader = new FileReader();
      reader.onload = (re) => {
        if (previewImg) previewImg.src = re.target.result;
        if (previewWrap) previewWrap.style.display = "block";
      };
      reader.readAsDataURL(file);

      // Start compression & database write
      isUploadingStepScreenshot = true;
      if (progressBar) progressBar.style.display = "block";
      if (progressFill) progressFill.style.width = "30%";
      if (statusMsg) {
        statusMsg.style.display = "block";
        statusMsg.style.background = "#e0f2fe";
        statusMsg.style.color = "#0369a1";
        statusMsg.style.border = "1px solid #bae6fd";
        statusMsg.textContent = "Optimizing screenshot for database storage...";
      }
      if (stateBadge) {
        stateBadge.textContent = "Compressing...";
        stateBadge.className = "payment-badge";
      }
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Processing Screenshot...";
      }

      if (!currentCheckoutOrderId) {
        currentCheckoutOrderId = await generateOrderId();
      }

      try {
        const compressed = await compressScreenshotForFirestore(file);

        if (progressFill) progressFill.style.width = "70%";
        if (statusMsg) statusMsg.textContent = "Saving screenshot to database...";
        if (stateBadge) stateBadge.textContent = "Saving...";

        // Dedicated document in payment_screenshots collection
        const screenshotDocRef = doc(collection(db, "payment_screenshots"));
        const screenshotDocId = screenshotDocRef.id;

        await setDoc(screenshotDocRef, {
          orderId: currentCheckoutOrderId,
          imageBase64: compressed.dataUrl,
          mimeType: compressed.mimeType,
          fileSize: compressed.byteSize,
          fileName: file.name || "screenshot.jpg",
          createdAt: serverTimestamp()
        });

        if (progressFill) progressFill.style.width = "100%";

        currentUpiScreenshotDocId = screenshotDocId;
        currentUpiScreenshotDataUrl = compressed.dataUrl;
        currentUpiScreenshotName = file.name;

        const kbSize = (compressed.byteSize / 1024).toFixed(1);
        if (statusMsg) {
          statusMsg.style.display = "block";
          statusMsg.style.background = "#def7ec";
          statusMsg.style.color = "#03543f";
          statusMsg.style.border = "1px solid #84e1bc";
          statusMsg.innerHTML = `✓ Payment screenshot recorded (${kbSize} KB)! You can now submit your order.`;
        }
        if (stateBadge) {
          stateBadge.textContent = "Uploaded";
          stateBadge.className = "payment-badge payment-verified";
          stateBadge.style.background = "#def7ec";
          stateBadge.style.color = "#03543f";
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Submit Order & Open WhatsApp";
        }
      } catch (err) {
        console.error("Screenshot database save failed:", err);
        currentUpiScreenshotDocId = null;
        currentUpiScreenshotDataUrl = null;
        if (statusMsg) {
          statusMsg.style.display = "block";
          statusMsg.style.background = "#fde8e8";
          statusMsg.style.color = "#9b1c1c";
          statusMsg.style.border = "1px solid #f8b4b4";
          statusMsg.textContent = "Save failed: " + err.message + ". Please try uploading again.";
        }
        if (stateBadge) {
          stateBadge.textContent = "Failed";
          stateBadge.className = "payment-badge payment-cod";
        }
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = "Upload Screenshot Above to Submit";
        }
      } finally {
        isUploadingStepScreenshot = false;
        if (progressBar) progressBar.style.display = "none";
      }
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      if (isSubmittingOrder) return;
      if (!currentUpiScreenshotDocId) {
        alert("Please upload your payment screenshot before submitting.");
        return;
      }
      await submitOrder("UPI");
    });
  }

  if ($("#btnDownloadUpiQr")) {
    $("#btnDownloadUpiQr").addEventListener("click", () => {
      downloadUpiQrImage();
    });
  }
}
setupStepScreenshotControls();

function showStep(n) {
  currentStep = n;
  document.querySelectorAll(".step-dot").forEach(d => {
    const s = Number(d.dataset.step);
    d.classList.toggle("active", s === n);
    d.classList.toggle("done", s < n);
  });
  document.querySelectorAll(".checkout-step").forEach(s => s.classList.toggle("active", Number(s.dataset.step) === n));
  if ($("#backStep")) $("#backStep").style.visibility = n === 1 ? "hidden" : "visible";
  
  if (n === 2) {
    if (CURRENT_CUSTOMER_PROFILE && checkoutOptionMode === "saved") {
      autofillCheckoutFromProfile(CURRENT_CUSTOMER_PROFILE);
    }
  }

  if (n === 5) {
    renderFinalSummary();
    setupPaymentMethodControls();
  } else {
    if ($("#nextStep")) {
      $("#nextStep").style.display = "block";
      $("#nextStep").textContent = "Continue";
    }
  }
}

function validateStep(n) {
  if (n === 2) {
    if (checkoutOptionMode === "saved") {
      if (!CURRENT_CUSTOMER_PROFILE) {
        toast("Please unlock your saved details or switch to Enter Manually.");
        return false;
      }
      autofillCheckoutFromProfile(CURRENT_CUSTOMER_PROFILE);
    }

    const name = $("#custName").value.trim();
    const rawMobile = $("#custMobile").value.trim();
    const rawWa = $("#custWhatsapp").value.trim();
    const cleanMob = rawMobile.replace(/\D/g, "");
    const cleanWa = rawWa.replace(/\D/g, "");

    if (!name) { toast("Please enter your Full Name."); return false; }
    if (!cleanMob || cleanMob.length !== 10) { toast("Please enter a valid 10-digit Mobile Number."); return false; }
    if (!cleanWa || cleanWa.length !== 10) { toast("Please enter a valid 10-digit WhatsApp Number."); return false; }

    const email = $("#custEmail").value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast("Please enter a valid email address.");
      return false;
    }

    if (checkoutOptionMode === "manual" && $("#chkGuestSaveProfile")?.checked) {
      const pin = $("#guestCreatePin")?.value.trim();
      const confirmPin = $("#guestConfirmPin")?.value.trim();
      if (!pin || pin.length < 4 || pin.length > 32) {
        toast("To save your details, enter a password/PIN of at least 4 characters.");
        return false;
      }
      if (pin !== confirmPin) {
        toast("Password/PIN and Confirm Password/PIN do not match.");
        return false;
      }
    }
  }

  if (n === 3) {
    const req = ["addrHouse", "addrStreet", "addrArea", "addrCity", "addrDistrict", "addrState"];
    for (const id of req) {
      if (!$("#" + id).value.trim()) { toast("Please complete all address fields."); return false; }
    }
    const pincode = $("#addrPincode").value.trim();
    if (!pincode || pincode.length !== 6 || !/^\d+$/.test(pincode)) {
      toast("Please enter a valid 6-digit Pincode.");
      return false;
    }
  }
  return true;
}

if ($("#nextStep")) {
  $("#nextStep").addEventListener("click", () => {
    if (!validateStep(currentStep)) return;
    if (currentStep === 5) { submitOrder(); return; }
    showStep(currentStep + 1);
  });
}

if ($("#backStep")) $("#backStep").addEventListener("click", () => { if (currentStep > 1) showStep(currentStep - 1); });

function renderFinalSummary() {
  const items = getCheckoutItems();
  const subtotal = getCheckoutSubtotal();
  const delivery = getCheckoutDeliveryCharge();
  const total = getCheckoutTotal();
  const addr = fullAddress();

  $("#finalSummary").innerHTML = `
    <div class="summary-block"><h4>Customer Details</h4>
      <p><strong>${removeEmojis($("#custName").value)}</strong><br>${$("#custMobile").value} ${$("#custEmail").value ? "· " + $("#custEmail").value : ""}</p></div>
    <div class="summary-block"><h4>Delivery Address</h4><p>${addr.replace(/\n/g, "<br>")}</p></div>
    <div class="summary-block"><h4>Order Items</h4>
      ${items.map(i => `<div class="order-line"><span>${removeEmojis(i.name)} ${i.color ? "(" + removeEmojis(i.color) + ")" : ""} × ${i.qty}</span><span>${money(i.price * i.qty)}</span></div>`).join("")}
      <div class="order-line" style="margin-top:8px; border-top:1px dashed #ddd; padding-top:6px;"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      <div class="order-line"><span>Delivery Charge</span><span>${money(delivery)}</span></div>
      <div class="order-line" style="font-weight:700; color:var(--rose-deep); font-size:1.05rem;"><span>Final Payable Total</span><span>${money(total)}</span></div>
    </div>
    ${$("#specialNotes").value.trim() ? `<div class="summary-block"><h4>Special Instructions</h4><p>${removeEmojis($("#specialNotes").value)}</p></div>` : ""}
  `;

  refreshUpiStepUI();
}

function fullAddress() {
  return [
    "House No: " + $("#addrHouse").value,
    "Street: " + $("#addrStreet").value,
    "Area: " + $("#addrArea").value,
    "City: " + $("#addrCity").value,
    "District: " + $("#addrDistrict").value,
    "State: " + $("#addrState").value,
    "Pincode: " + $("#addrPincode").value,
  ].join("\n");
}

async function generateOrderId() {
  const n = Date.now().toString().slice(-6);
  return "BA-" + n;
}

function getCleanWhatsappPhone(rawPhone) {
  if (!rawPhone) return "917397536605";
  let cleaned = String(rawPhone).replace(/\D/g, "");
  if (!cleaned) return "917397536605";
  if (cleaned.length === 10) {
    cleaned = "91" + cleaned;
  }
  return cleaned;
}

function buildWhatsappMessage(orderId, items, subtotal, delivery, total) {
  const storeName = removeEmojis(SETTINGS.businessName || "BLUME ARTS").toUpperCase();
  const isUpi = (selectedPaymentMethod === "UPI");

  let msg = `==================\n${storeName}\nNEW ORDER\n==================\n\n`;
  msg += `Order ID: ${orderId}\n\nORDER DETAILS:\n\n`;
  items.forEach((i, idx) => {
    msg += `${idx + 1}. ${removeEmojis(i.name)}${i.color ? " (" + removeEmojis(i.color) + ")" : ""}\nQuantity: ${i.qty}\nPrice: ${money(i.price)}\nSubtotal: ${money(i.price * i.qty)}\n\n`;
  });
  msg += `==================\nSubtotal: ${money(subtotal)}\nDelivery Charge: ${money(delivery)}\nFINAL TOTAL: ${money(total)}\n\n`;
  msg += `PAYMENT METHOD: ${isUpi ? "Online UPI (Pending Verification)" : "Cash on Delivery"}\n`;
  if (isUpi) {
    msg += `PAYMENT PROOF: Screenshot uploaded to portal (Ref Order ID: #${orderId})\n`;
  }
  msg += `\nCUSTOMER DETAILS:\n\n`;
  msg += `Name: ${removeEmojis($("#custName")?.value || "")}\nMobile: ${$("#custMobile")?.value || ""}\nWhatsApp: ${$("#custWhatsapp")?.value || ""}\nEmail: ${$("#custEmail")?.value || "N/A"}\n\nDELIVERY ADDRESS:\n\n${fullAddress()}\n\n`;
  msg += `SPECIAL INSTRUCTIONS:\n\n${removeEmojis($("#specialNotes")?.value || "").trim() || "None"}\n\n`;
  msg += `==================\nThank you for choosing ${storeName}\n==================`;
  return msg;
}

function resetCheckoutForm() {
  const ids = [
    "custName", "custMobile", "custWhatsapp", "custEmail",
    "addrHouse", "addrStreet", "addrArea", "addrCity", "addrDistrict", "addrState", "addrPincode",
    "specialNotes", "coAuthMobile", "coAuthPin", "guestCreatePin", "guestConfirmPin"
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  if ($("#chkGuestSaveProfile")) $("#chkGuestSaveProfile").checked = false;
  if ($("#guestPinFields")) $("#guestPinFields").style.display = "none";
  if ($("#chkSameAsMobile")) $("#chkSameAsMobile").checked = false;

  currentUpiScreenshotDocId = null;
  currentUpiScreenshotDataUrl = null;
  currentUpiScreenshotName = null;
  currentCheckoutOrderId = null;
  isUploadingStepScreenshot = false;
  if ($("#upiStepScreenshotFile")) $("#upiStepScreenshotFile").value = "";
  if ($("#upiStepScreenshotPreviewWrap")) $("#upiStepScreenshotPreviewWrap").style.display = "none";
  if ($("#upiStepUploadProgressBar")) $("#upiStepUploadProgressBar").style.display = "none";
  if ($("#upiStepUploadStatus")) $("#upiStepUploadStatus").style.display = "none";
  if ($("#upiScreenshotStateBadge")) {
    $("#upiScreenshotStateBadge").textContent = "Required";
    $("#upiScreenshotStateBadge").className = "payment-badge";
    $("#upiScreenshotStateBadge").style.background = "";
    $("#upiScreenshotStateBadge").style.color = "";
  }
  if ($("#btnSubmitUpiOrder")) {
    $("#btnSubmitUpiOrder").disabled = true;
    $("#btnSubmitUpiOrder").textContent = "Upload Screenshot Above to Submit";
  }

  selectedPaymentMethod = "COD";
  currentStep = 1;
}

let isSubmittingOrder = false;

async function submitOrder(customPaymentMethod = null) {
  if (isSubmittingOrder) {
    console.warn("Order submission already in progress.");
    return;
  }
  isSubmittingOrder = true;

  const items = getCheckoutItems();
  const subtotal = getCheckoutSubtotal();
  const deliveryCharge = getCheckoutDeliveryCharge();
  const total = getCheckoutTotal();
  const orderId = currentCheckoutOrderId || await generateOrderId();
  currentCheckoutOrderId = orderId;
  const method = customPaymentMethod || selectedPaymentMethod || "COD";
  const isUpi = (method === "UPI");
  const paymentMethod = isUpi ? "UPI" : "COD";
  const paymentStatus = isUpi ? "Pending Verification" : "Pending (Cash on Delivery)";

  const nextBtn = $("#nextStep");
  const submitUpiBtn = $("#btnSubmitUpiOrder");
  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.textContent = "Processing Order...";
  }
  if (submitUpiBtn) {
    submitUpiBtn.disabled = true;
    submitUpiBtn.textContent = "Submitting Order...";
  }

  let orderDocId = null;

  try {
    // Atomic Stock Verification & Order Creation Transaction
    await runTransaction(db, async (transaction) => {
      const productUpdates = [];

      for (const item of items) {
        if (!item.id) continue;
        const pRef = doc(db, "products", item.id);
        const pSnap = await transaction.get(pRef);
        if (!pSnap.exists()) {
          throw new Error(`Product "${item.name}" is no longer available.`);
        }
        const pData = pSnap.data();
        const isUnlimited = Boolean(pData.unlimitedStock);
        if (!isUnlimited) {
          const currentStock = Number(pData.stockQuantity !== undefined ? pData.stockQuantity : (pData.stock || 0));
          if (currentStock < item.qty) {
            throw new Error(`Insufficient stock for "${item.name}". Only ${currentStock} item(s) left.`);
          }
          productUpdates.push({ ref: pRef, newStock: currentStock - item.qty });
        }
      }

      for (const update of productUpdates) {
        transaction.update(update.ref, {
          stockQuantity: update.newStock,
          stock: update.newStock,
          updatedAt: serverTimestamp()
        });
      }

      const newOrderRef = doc(collection(db, "orders"));
      orderDocId = newOrderRef.id;

      const orderData = {
        orderId,
        customerName: $("#custName").value.trim(),
        mobile: $("#custMobile").value.trim().replace(/\D/g, ""),
        whatsapp: $("#custWhatsapp").value.trim().replace(/\D/g, ""),
        email: $("#custEmail").value.trim() || "",
        address: {
          house: $("#addrHouse").value.trim(),
          street: $("#addrStreet").value.trim(),
          area: $("#addrArea").value.trim(),
          city: $("#addrCity").value.trim(),
          district: $("#addrDistrict").value.trim(),
          state: $("#addrState").value.trim(),
          pincode: $("#addrPincode").value.trim(),
        },
        products: items,
        subtotal,
        deliveryCharge,
        total,
        status: "Order Placed",
        paymentMethod,
        paymentStatus,
        paymentScreenshot: isUpi ? ("ref:payment_screenshots/" + currentUpiScreenshotDocId) : "",
        screenshotDocId: isUpi ? (currentUpiScreenshotDocId || "") : "",
        screenshotSubmitted: isUpi ? true : false,
        orderSubmitted: true,
        statusHistory: [
          {
            status: "Order Placed",
            timestamp: new Date().toISOString(),
            note: isUpi 
              ? "Order placed via Online UPI QR. Payment screenshot recorded in database. Status: Pending Verification." 
              : "Order placed with Cash on Delivery (Pending)"
          }
        ],
        notes: $("#specialNotes").value.trim() || "",
        createdAt: serverTimestamp(),
      };
      transaction.set(newOrderRef, orderData);
    });

    // Vault profile saving if logged in or guest opted-in
    if (CURRENT_CUSTOMER_PROFILE && CURRENT_CUSTOMER_VAULT_KEY) {
      persistCustomerVaultProfile({
        fullName: $("#custName").value.trim() || CURRENT_CUSTOMER_PROFILE.fullName,
        mobile: CURRENT_CUSTOMER_PROFILE.mobile,
        whatsapp: $("#custWhatsapp").value.trim() || CURRENT_CUSTOMER_PROFILE.whatsapp,
        email: $("#custEmail").value.trim() || CURRENT_CUSTOMER_PROFILE.email,
        address: {
          house: $("#addrHouse").value.trim(),
          street: $("#addrStreet").value.trim(),
          area: $("#addrArea").value.trim(),
          city: $("#addrCity").value.trim(),
          district: $("#addrDistrict").value.trim(),
          state: $("#addrState").value.trim(),
          pincode: $("#addrPincode").value.trim()
        }
      }).catch(e => console.warn("Notice updating vault address:", e.message));
    }

    if ($("#chkGuestSaveProfile")?.checked && checkoutOptionMode === "manual") {
      const guestMobile = $("#custMobile").value.trim().replace(/\D/g, "");
      const guestPin = $("#guestCreatePin")?.value.trim();
      if (guestMobile.length === 10 && guestPin && guestPin.length >= 4) {
        persistCustomerVaultProfile({
          fullName: $("#custName").value.trim(),
          mobile: guestMobile,
          whatsapp: $("#custWhatsapp").value.trim().replace(/\D/g, ""),
          email: $("#custEmail").value.trim() || "",
          address: {
            house: $("#addrHouse").value.trim(),
            street: $("#addrStreet").value.trim(),
            area: $("#addrArea").value.trim(),
            city: $("#addrCity").value.trim(),
            district: $("#addrDistrict").value.trim(),
            state: $("#addrState").value.trim(),
            pincode: $("#addrPincode").value.trim(),
          },
          password: guestPin
        }).catch(e => console.warn("Background guest profile save notice:", e.message));
      }
    }

    const waMessage = buildWhatsappMessage(orderId, items, subtotal, deliveryCharge, total);
    const cleanPhone = getCleanWhatsappPhone(SETTINGS.whatsapp || SETTINGS.phone);
    const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waMessage)}`;

    lastOrder = {
      orderId,
      docId: orderDocId,
      items,
      subtotal,
      deliveryCharge,
      total,
      waUrl,
      waMessage,
      phone: cleanPhone,
      paymentMethod,
      paymentStatus,
      paymentScreenshot: isUpi ? currentUpiScreenshotUrl : ""
    };
    sessionStorage.setItem("blume_last_order", JSON.stringify(lastOrder));

    if (checkoutMode === "cart") { CART = []; saveCart(); renderCart(); }
    buyNowItem = null;

    $("#checkoutOverlay").classList.remove("open");
    $("#confirmOrderId").textContent = orderId;

    const confTitle = $("#confirmTitle");
    const confSub = $("#confirmSubtitle");
    const confInst = $("#confirmInstructions");
    const confActions = $("#confirmActionsWrap") || document.querySelector(".confirm-actions");
    const confMethodBadge = $("#confirmPaymentMethodBadge");
    const confStatusBadge = $("#confirmPaymentStatusBadge");

    if (confMethodBadge) {
      confMethodBadge.textContent = isUpi ? "Online UPI" : "Cash on Delivery";
      confMethodBadge.className = "payment-badge " + (isUpi ? "payment-verified" : "payment-cod");
    }
    if (confStatusBadge) {
      confStatusBadge.textContent = paymentStatus;
      confStatusBadge.className = "payment-badge payment-pending";
    }

    if (confTitle) confTitle.textContent = "Your Order Is Recorded";
    if (confSub) confSub.textContent = isUpi
      ? `Your order #${orderId} and payment screenshot have been securely recorded.`
      : "Your order has been securely saved in our database and prepared in WhatsApp.";
    if (confInst) {
      confInst.style.display = "block";
      confInst.innerHTML = "Please press <strong>Send</strong> in WhatsApp to complete your message to our team.";
    }
    if (confActions) confActions.style.display = "flex";

    $("#confirmOverlay").classList.add("open");
    document.body.style.overflow = "hidden";

    // Automatically initiate WhatsApp redirection
    try {
      window.open(waUrl, "_blank");
    } catch (waErr) {
      console.warn("Automatic WhatsApp window blocked or failed:", waErr.message);
    }

  } catch (err) {
    console.error("Order submit transaction error:", err);
    alert(`Order Failed: ${err.message}`);
    toast(`Order Failed: ${err.message}`);
  } finally {
    isSubmittingOrder = false;
    if (nextBtn) {
      nextBtn.disabled = false;
      nextBtn.textContent = "Confirm Order (Cash on Delivery)";
    }
    if (submitUpiBtn) {
      submitUpiBtn.disabled = !currentUpiScreenshotDocId;
      submitUpiBtn.textContent = currentUpiScreenshotDocId ? "Submit Order & Open WhatsApp" : "Upload Screenshot Above to Submit";
    }
  }
}

// Event Listeners for Order Confirmation Modal Buttons
if ($("#openWhatsappBtn")) {
  $("#openWhatsappBtn").addEventListener("click", () => {
    let orderToOpen = lastOrder;
    if (!orderToOpen || !orderToOpen.waUrl) {
      try {
        const stored = sessionStorage.getItem("blume_last_order");
        if (stored) orderToOpen = JSON.parse(stored);
      } catch (e) {}
    }
    if (!orderToOpen || !orderToOpen.waUrl) {
      alert("Order details are missing. Please try placing your order again.");
      toast("Order details missing.");
      return;
    }
    window.open(orderToOpen.waUrl, "_blank");
  });
}

if ($("#continueShoppingBtn")) {
  $("#continueShoppingBtn").addEventListener("click", () => {
    $("#confirmOverlay").classList.remove("open");
    document.body.style.overflow = "";

    const shopEl = document.getElementById("shop");
    if (shopEl) {
      shopEl.scrollIntoView({ behavior: "smooth" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    resetCheckoutForm();
  });
}

if ($("#confirmOverlay")) {
  $("#confirmOverlay").addEventListener("click", (e) => {
    if (e.target.id === "confirmOverlay") {
      $("#confirmOverlay").classList.remove("open");
      document.body.style.overflow = "";
    }
  });
}

// ---------- TRACK YOUR ORDER (REAL-TIME STATUS & TIMELINE) ----------
let currentTrackedOrder = null;

if ($("#trackOrderForm")) {
  $("#trackOrderForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const orderIdInput = $("#trackOrderId").value.trim().toUpperCase();
    const verifyInput = $("#trackVerifyInput").value.trim();
    const btn = $("#trackSubmitBtn");

    if (!orderIdInput || !verifyInput) {
      toast("Please enter Order ID and Verification Mobile/Pincode.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Verifying...";

    try {
      const q = query(collection(db, "orders"), where("orderId", "==", orderIdInput));
      const snap = await getDocs(q);

      if (snap.empty) {
        toast("No order found with ID: " + orderIdInput);
        $("#trackResultWrap").style.display = "none";
        return;
      }

      let matchedDoc = null;
      snap.forEach(d => {
        const data = d.data();
        const mob = (data.mobile || "").replace(/\s/g, "");
        const wa = (data.whatsapp || "").replace(/\s/g, "");
        const pin = (data.address?.pincode || "").replace(/\s/g, "");
        const cleanInput = verifyInput.replace(/\s/g, "");

        if (cleanInput && (mob.endsWith(cleanInput) || wa.endsWith(cleanInput) || pin === cleanInput)) {
          matchedDoc = { id: d.id, ...data };
        }
      });

      if (!matchedDoc) {
        alert("Security Verification Failed: The Mobile Number or Pincode does not match this Order ID.");
        toast("Verification failed.");
        $("#trackResultWrap").style.display = "none";
        return;
      }

      currentTrackedOrder = matchedDoc;
      renderTrackResult(matchedDoc);

      // Listen for real-time order status updates!
      onSnapshot(doc(db, "orders", matchedDoc.id), (docSnap) => {
        if (docSnap.exists()) {
          currentTrackedOrder = { id: docSnap.id, ...docSnap.data() };
          renderTrackResult(currentTrackedOrder);
        }
      });

    } catch (err) {
      console.error("Track order error:", err);
      toast("Error tracking order: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Track Order";
    }
  });
}

// ---------- YOUR ORDER ID: SEARCH ORDERS BY MOBILE NUMBER (CHANGE 2) ----------
if ($("#findOrderIdForm")) {
  $("#findOrderIdForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const rawMobile = $("#findOrderMobileInput")?.value.trim() || "";
    const cleanMobile = rawMobile.replace(/\D/g, "");
    const btn = $("#btnFindOrders");
    const resultsWrap = $("#findOrderResultsWrap");
    const countBanner = $("#findOrderCountBanner");
    const resultsList = $("#findOrderResultsList");

    if (!cleanMobile || cleanMobile.length !== 10) {
      toast("Please enter a valid 10-digit mobile number.");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span>Searching...</span>`;
    }
    if (resultsWrap) resultsWrap.style.display = "block";
    if (countBanner) countBanner.innerHTML = `<span style="opacity:.75;">Searching orders for <strong>${cleanMobile}</strong>...</span>`;
    if (resultsList) resultsList.innerHTML = `<div style="text-align:center; padding:12px; font-size:.8rem; opacity:.7;">Loading matching orders...</div>`;

    try {
      // Query orders strictly by customer mobile number (secure verification)
      const q = query(collection(db, "orders"), where("mobile", "==", cleanMobile));
      const snap = await getDocs(q);

      const matchedOrders = [];
      snap.forEach(docSnap => {
        const d = docSnap.data();
        const orderId = d.orderId || docSnap.id;
        
        let dateStr = "—";
        let timeStr = "";
        let millis = 0;
        if (d.createdAt?.toDate) {
          const dt = d.createdAt.toDate();
          dateStr = dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
          timeStr = dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
          millis = dt.getTime();
        } else if (d.createdAt) {
          const dt = new Date(d.createdAt);
          if (!isNaN(dt.getTime())) {
            dateStr = dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
            timeStr = dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
            millis = dt.getTime();
          }
        }

        // Security & Privacy: Expose strictly safe non-private fields (Order ID, date, time, status)
        matchedOrders.push({
          orderId,
          dateStr,
          timeStr,
          status: d.status || "Order Placed",
          paymentStatus: d.paymentStatus || "",
          timestamp: millis
        });
      });

      // Also check whatsapp field if no matching orders found
      if (matchedOrders.length === 0) {
        const qWa = query(collection(db, "orders"), where("whatsapp", "==", cleanMobile));
        const snapWa = await getDocs(qWa);
        snapWa.forEach(docSnap => {
          const d = docSnap.data();
          const orderId = d.orderId || docSnap.id;
          let dateStr = "—";
          let timeStr = "";
          let millis = 0;
          if (d.createdAt?.toDate) {
            const dt = d.createdAt.toDate();
            dateStr = dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
            timeStr = dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
            millis = dt.getTime();
          }
          matchedOrders.push({
            orderId,
            dateStr,
            timeStr,
            status: d.status || "Order Placed",
            paymentStatus: d.paymentStatus || "",
            timestamp: millis
          });
        });
      }

      // Sort results from newest to oldest
      matchedOrders.sort((a, b) => b.timestamp - a.timestamp);

      if (matchedOrders.length === 0) {
        if (countBanner) {
          countBanner.innerHTML = `<span style="color:#b91c1c;">No orders found associated with mobile number <strong>${cleanMobile}</strong>.</span>`;
        }
        if (resultsList) {
          resultsList.innerHTML = `
            <div style="background:var(--cream); border:1px dashed var(--beige); border-radius:10px; padding:16px; text-align:center; font-size:.8rem; color:var(--brown);">
              Please verify that you entered the exact 10-digit mobile number used during checkout.
            </div>
          `;
        }
      } else {
        if (countBanner) {
          countBanner.innerHTML = `<span style="color:var(--rose-deep);">Found <strong>${matchedOrders.length}</strong> matching order(s) for <strong>${cleanMobile}</strong>:</span>`;
        }
        if (resultsList) {
          resultsList.innerHTML = matchedOrders.map(item => `
            <div style="display:flex; justify-content:space-between; align-items:center; background:var(--cream); border:1px solid var(--beige); border-radius:10px; padding:12px 14px; flex-wrap:wrap; gap:8px;">
              <div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <strong style="font-family:monospace; font-size:.95rem; color:var(--brown);">${item.orderId}</strong>
                  <span class="status-pill-badge sm" style="font-size:.68rem; padding:3px 8px;">${item.status}</span>
                </div>
                <div style="font-size:.74rem; opacity:.75; margin-top:3px;">
                  Date: ${item.dateStr}${item.timeStr ? ` | Time: ${item.timeStr}` : ""}
                </div>
              </div>
              <button type="button" class="btn btn-outline btn-sm btn-quick-track-order" data-order-id="${item.orderId}" data-mobile="${cleanMobile}" style="font-size:.76rem; padding:5px 12px; cursor:pointer;">
                Track Order ➔
              </button>
            </div>
          `).join("");

          // Connect clicking "Track Order" to populate and submit existing Track Order form
          resultsList.querySelectorAll(".btn-quick-track-order").forEach(trkBtn => {
            trkBtn.addEventListener("click", () => {
              const oId = trkBtn.dataset.orderId;
              const mob = trkBtn.dataset.mobile;
              if ($("#trackOrderId")) $("#trackOrderId").value = oId;
              if ($("#trackVerifyInput")) $("#trackVerifyInput").value = mob;
              const trkForm = $("#trackOrderForm");
              if (trkForm) {
                trkForm.scrollIntoView({ behavior: "smooth" });
                trkForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
              }
            });
          });
        }
      }

    } catch (err) {
      console.error("Find orders error:", err);
      if (countBanner) countBanner.innerHTML = `<span style="color:#b91c1c;">Error searching orders: ${err.message}</span>`;
      if (resultsList) resultsList.innerHTML = "";
      toast("Error searching orders: " + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <span>Search</span>
        `;
      }
    }
  });
}

function renderTrackResult(o) {
  const wrap = $("#trackResultWrap");
  if (!wrap) return;

  $("#trackDisplayOrderId").textContent = `Order #${o.orderId}`;
  $("#trackDisplayDate").textContent = `Placed on ${o.createdAt?.toDate ? o.createdAt.toDate().toLocaleString() : "Recently"}`;
  
  const statusBadge = $("#trackStatusBadge");
  if (statusBadge) {
    statusBadge.textContent = o.status || "Order Placed";
    statusBadge.className = "status-pill-badge " + (o.status === "Cancelled" ? "cancelled" : (o.status === "Delivered" ? "delivered" : "active"));
  }

  const payMethodBadge = $("#trackPaymentMethodBadge");
  if (payMethodBadge) {
    payMethodBadge.textContent = o.paymentMethod === "UPI" ? "Online UPI" : "Cash on Delivery";
    payMethodBadge.className = "payment-badge " + (o.paymentMethod === "UPI" ? "payment-verified" : "payment-cod");
  }

  const payStatusBadge = $("#trackPaymentStatusBadge");
  if (payStatusBadge) {
    const payStatus = o.paymentStatus || (o.paymentMethod === "UPI" ? "Payment Pending Verification" : "Pending (Cash on Delivery)");
    payStatusBadge.textContent = payStatus;
    payStatusBadge.className = "payment-badge " + (payStatus.includes("Verified") ? "payment-verified" : (payStatus.includes("Failed") ? "payment-failed" : "payment-pending"));
  }

  // 6-step lifecycle timeline
  const lifecycleSteps = ["Order Placed", "Confirmed", "Preparing", "Packing", "Out for Delivery", "Delivered"];
  const currentStatusIndex = lifecycleSteps.indexOf(o.status);

  document.querySelectorAll("#timelineStepper .step-node").forEach((node) => {
    const stepName = node.dataset.step;
    const stepIdx = lifecycleSteps.indexOf(stepName);
    node.classList.remove("active", "completed");

    if (o.status === "Cancelled") {
      // Cancelled state
    } else if (stepIdx < currentStatusIndex) {
      node.classList.add("completed");
    } else if (stepIdx === currentStatusIndex) {
      node.classList.add("active");
    }
  });

  const cancelBanner = $("#cancelledBanner");
  if (cancelBanner) {
    cancelBanner.style.display = o.status === "Cancelled" ? "block" : "none";
  }

  // Render Status History Timeline with timestamps
  const historyWrap = $("#trackHistoryTimeline");
  if (historyWrap) {
    const historyList = o.statusHistory || [{ status: o.status || "Order Placed", timestamp: new Date().toISOString() }];
    historyWrap.innerHTML = historyList.map(h => `
      <div class="history-item">
        <span class="hist-status">${h.status}</span>
        <span class="hist-time">${h.timestamp ? new Date(h.timestamp).toLocaleString() : ""}</span>
      </div>
    `).join("");
  }

  // Render Order Items
  const itemsWrap = $("#trackItemsList");
  if (itemsWrap) {
    itemsWrap.innerHTML = (o.products || []).map(p => `
      <div class="track-item-row">
        <span><strong>${removeEmojis(p.name)}</strong> ${p.color ? "(" + removeEmojis(p.color) + ")" : ""} × ${p.qty}</span>
        <span>${money((p.price || 0) * (p.qty || 1))}</span>
      </div>
    `).join("");
  }

  if ($("#trackSubtotal")) $("#trackSubtotal").textContent = money(o.subtotal || 0);
  if ($("#trackDelivery")) $("#trackDelivery").textContent = money(o.deliveryCharge || 0);
  if ($("#trackTotal")) $("#trackTotal").textContent = money(o.total || 0);

  // Render Seller Messages with Real-Time Listener
  const msgWrap = $("#trackMessagesWrap");
  const msgList = $("#trackSellerMessagesList");
  if (msgWrap && msgList && o.id) {
    msgWrap.style.display = "block";
    onSnapshot(collection(db, "orders", o.id, "sellerMessages"), (snap) => {
      if (snap.empty) {
        msgList.innerHTML = `<p style="font-size:.78rem; opacity:.6; font-style:italic;">No messages from seller yet.</p>`;
        return;
      }
      const docs = [];
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
      docs.sort((a, b) => {
        const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.timestamp ? new Date(a.timestamp).getTime() : 0);
        const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.timestamp ? new Date(b.timestamp).getTime() : 0);
        return tA - tB;
      });

      msgList.innerHTML = docs.map(d => {
        const timeStr = d.createdAt?.toDate ? d.createdAt.toDate().toLocaleString() : (d.timestamp ? new Date(d.timestamp).toLocaleString() : "");
        return `
          <div class="seller-msg-card">
            <div class="seller-msg-text">${removeEmojis(d.messageText)}</div>
            <div class="seller-msg-time">${timeStr}</div>
          </div>
        `;
      }).join("");
    });
  }

  // Payment Screenshot Evidence & Later Upload (UPI Orders Only)
  const trackScreenshotBlock = $("#trackScreenshotBlock");
  if (trackScreenshotBlock) {
    if (o.paymentMethod === "UPI") {
      trackScreenshotBlock.style.display = "block";
      const statusBadge = $("#trackScreenshotStatusBadge");
      const displayWrap = $("#trackScreenshotDisplayWrap");
      const uploadWrap = $("#trackScreenshotUploadWrap");
      const imgEl = $("#trackScreenshotImg");
      const linkEl = $("#trackScreenshotLink");
      const linkTextEl = $("#trackScreenshotLinkText");
      const successEl = $("#trackScreenshotSuccess");
      if (successEl) successEl.style.display = "none";

      const screenshotDocId = o.screenshotDocId || (o.paymentScreenshot?.startsWith("ref:payment_screenshots/") ? o.paymentScreenshot.replace("ref:payment_screenshots/", "") : null);

      if (screenshotDocId) {
        if (statusBadge) {
          statusBadge.textContent = "Screenshot Recorded (Database)";
          statusBadge.className = "payment-badge payment-verified";
        }
        if (displayWrap) displayWrap.style.display = "flex";
        if (uploadWrap) uploadWrap.style.display = "none";

        // Load screenshot Base64 data from payment_screenshots collection
        getDoc(doc(db, "payment_screenshots", screenshotDocId)).then(snap => {
          if (snap.exists() && snap.data().imageBase64) {
            const b64 = snap.data().imageBase64;
            if (imgEl) {
              imgEl.style.display = "block";
              imgEl.src = b64;
            }
            if (linkEl) linkEl.href = b64;
            if (linkTextEl) {
              linkTextEl.href = b64;
              linkTextEl.target = "_blank";
              linkTextEl.textContent = "Inspect full screenshot in new tab ↗";
            }
          }
        }).catch(err => {
          console.warn("Could not load screenshot document:", err.message);
        });
      } else if (o.paymentScreenshot && !o.paymentScreenshot.startsWith("ref:")) {
        if (statusBadge) {
          statusBadge.textContent = "Screenshot Uploaded";
          statusBadge.className = "payment-badge payment-verified";
        }
        if (displayWrap) displayWrap.style.display = "flex";
        if (uploadWrap) uploadWrap.style.display = "none";
        if (imgEl) {
          imgEl.style.display = "block";
          imgEl.src = o.paymentScreenshot;
        }
        if (linkEl) linkEl.href = o.paymentScreenshot;
        if (linkTextEl) {
          linkTextEl.href = o.paymentScreenshot;
          linkTextEl.textContent = "Inspect full screenshot in new tab ↗";
        }
      } else {
        if (statusBadge) {
          statusBadge.textContent = "Screenshot Not Uploaded";
          statusBadge.className = "payment-badge payment-pending";
        }
        if (displayWrap) displayWrap.style.display = "none";
        if (uploadWrap) uploadWrap.style.display = "block";
      }
    } else {
      trackScreenshotBlock.style.display = "none";
    }
  }

  // Review Prompt (Delivered Orders Only)
  const revPrompt = $("#trackReviewPrompt");
  if (revPrompt) {
    revPrompt.style.display = o.status === "Delivered" ? "block" : "none";
  }

  wrap.style.display = "block";
  wrap.scrollIntoView({ behavior: "smooth" });
}

// ------------------------------------------------------------
// TRACK ORDER: PAYMENT SCREENSHOT LATER UPLOAD LISTENERS
// ------------------------------------------------------------
let trackSelectedFile = null;

if ($("#trackScreenshotFile")) {
  $("#trackScreenshotFile").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      trackSelectedFile = null;
      if ($("#trackScreenshotPreviewWrap")) $("#trackScreenshotPreviewWrap").style.display = "none";
      if ($("#btnUploadTrackScreenshot")) $("#btnUploadTrackScreenshot").style.display = "none";
      return;
    }
    if (!file.type.match(/^image\/(jpeg|png|webp)$/i)) {
      alert("Please select a valid JPG, PNG, or WebP image.");
      e.target.value = "";
      trackSelectedFile = null;
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      alert("Screenshot file size must be less than 15MB.");
      e.target.value = "";
      trackSelectedFile = null;
      return;
    }

    trackSelectedFile = file;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if ($("#trackScreenshotPreview")) $("#trackScreenshotPreview").src = ev.target.result;
      if ($("#trackScreenshotPreviewWrap")) $("#trackScreenshotPreviewWrap").style.display = "block";
      if ($("#btnUploadTrackScreenshot")) $("#btnUploadTrackScreenshot").style.display = "block";
    };
    reader.readAsDataURL(file);
  });
}

if ($("#btnRemoveTrackScreenshot")) {
  $("#btnRemoveTrackScreenshot").addEventListener("click", () => {
    trackSelectedFile = null;
    if ($("#trackScreenshotFile")) $("#trackScreenshotFile").value = "";
    if ($("#trackScreenshotPreviewWrap")) $("#trackScreenshotPreviewWrap").style.display = "none";
    if ($("#btnUploadTrackScreenshot")) $("#btnUploadTrackScreenshot").style.display = "none";
  });
}

if ($("#btnUploadTrackScreenshot")) {
  $("#btnUploadTrackScreenshot").addEventListener("click", async () => {
    if (!trackSelectedFile || !currentTrackedOrder) {
      alert("Please choose a screenshot image first.");
      return;
    }

    const btn = $("#btnUploadTrackScreenshot");
    btn.disabled = true;
    btn.textContent = "Optimizing & Saving to Database...";

    try {
      const compressed = await compressScreenshotForFirestore(trackSelectedFile);

      // Save to dedicated collection: payment_screenshots
      const screenshotDocRef = doc(collection(db, "payment_screenshots"));
      const screenshotDocId = screenshotDocRef.id;

      await setDoc(screenshotDocRef, {
        orderId: currentTrackedOrder.orderId,
        imageBase64: compressed.dataUrl,
        mimeType: compressed.mimeType,
        fileSize: compressed.byteSize,
        fileName: trackSelectedFile.name || "screenshot.jpg",
        createdAt: serverTimestamp()
      });

      const orderUpdate = {
        paymentScreenshot: "ref:payment_screenshots/" + screenshotDocId,
        screenshotDocId: screenshotDocId,
        screenshotSubmitted: true,
        paymentStatus: "Screenshot Submitted",
        updatedAt: serverTimestamp()
      };
      await updateDoc(doc(db, "orders", currentTrackedOrder.id), orderUpdate);

      currentTrackedOrder.paymentScreenshot = "ref:payment_screenshots/" + screenshotDocId;
      currentTrackedOrder.screenshotDocId = screenshotDocId;
      currentTrackedOrder.screenshotSubmitted = true;
      currentTrackedOrder.paymentStatus = "Screenshot Submitted";
      renderTrackResult(currentTrackedOrder);

      if ($("#trackScreenshotSuccess")) {
        $("#trackScreenshotSuccess").style.display = "block";
        $("#trackScreenshotSuccess").innerHTML = `✓ Payment screenshot saved to database!<br><span style="font-size:.72rem; opacity:.85;">Reference Doc ID: ${screenshotDocId}</span>`;
      }
      toast("Payment screenshot attached successfully!");
    } catch (err) {
      console.error("Track screenshot save error:", err);
      alert("Upload Error: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Upload Payment Screenshot";
    }
  });
}

// ---------- VERIFIED PRODUCT REVIEWS ----------
if ($("#openReviewModalBtn")) {
  $("#openReviewModalBtn").addEventListener("click", () => {
    if (!currentTrackedOrder) return;
    $("#revOrderId").value = currentTrackedOrder.orderId;
    $("#revMobile").value = currentTrackedOrder.mobile;
    $("#revCustName").value = currentTrackedOrder.customerName;

    const select = $("#revProductSelect");
    if (select) {
      select.innerHTML = `<option value="">Select Item from Order</option>` +
        (currentTrackedOrder.products || []).map(p => `<option value="${p.id}">${removeEmojis(p.name)}</option>`).join("");
    }
    $("#reviewModalOverlay").classList.add("open");
  });
}

if ($("#closeReviewModal")) {
  $("#closeReviewModal").addEventListener("click", () => {
    $("#reviewModalOverlay").classList.remove("open");
  });
}

if ($("#reviewForm")) {
  $("#reviewForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const orderId = $("#revOrderId").value.trim().toUpperCase();
    const mobile = $("#revMobile").value.trim();
    const productId = $("#revProductSelect").value;
    const name = $("#revCustName").value.trim();
    const rating = Number($("#revRating").value);
    const comment = $("#revComment").value.trim();
    const btn = $("#submitReviewBtn");

    if (!orderId || !mobile || !productId || !name || !comment) {
      toast("Please fill in all review fields.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Submitting Review...";

    try {
      // Step 1: Verify Purchaser & Order Status = Delivered
      const q = query(collection(db, "orders"), where("orderId", "==", orderId));
      const snap = await getDocs(q);

      if (snap.empty) {
        throw new Error("Order ID not found.");
      }

      let validOrder = null;
      snap.forEach(d => {
        const data = d.data();
        if ((data.mobile || "").replace(/\s/g, "").endsWith(mobile.replace(/\s/g, ""))) {
          validOrder = data;
        }
      });

      if (!validOrder) {
        throw new Error("Mobile number does not match Order ID.");
      }

      if (validOrder.status !== "Delivered") {
        throw new Error("Reviews can only be submitted for Delivered orders.");
      }

      // Step 2: Prevent Duplicate Reviews
      const reviewDocId = `${orderId}_${productId}`;
      const revRef = doc(db, "reviews", reviewDocId);
      const revSnap = await getDoc(revRef);

      if (revSnap.exists()) {
        throw new Error("You have already submitted a review for this item from this order.");
      }

      // Step 3: Save Review Document
      await setDoc(revRef, {
        reviewId: reviewDocId,
        orderId,
        productId,
        customerName: removeEmojis(name),
        rating,
        comment: removeEmojis(comment),
        status: "approved",
        createdAt: serverTimestamp()
      });

      // Step 4: Atomic Recalculation of Average Product Rating
      const revQ = query(collection(db, "reviews"), where("productId", "==", productId), where("status", "==", "approved"));
      const allRevsSnap = await getDocs(revQ);
      let sumRating = 0, count = 0;
      allRevsSnap.forEach(rd => {
        sumRating += Number(rd.data().rating || 5);
        count++;
      });

      const avgRating = count > 0 ? (sumRating / count) : rating;
      await updateDoc(doc(db, "products", productId), {
        avgRating,
        reviewCount: count
      });

      alert("Thank you! Your verified review has been published.");
      toast("Review submitted successfully!");
      $("#reviewModalOverlay").classList.remove("open");

    } catch (err) {
      console.error("Submit review error:", err);
      alert("Review Error: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Submit Verified Review";
    }
  });
}

// ---------- INIT ----------
renderCartBadge();
renderCart();
loadSettings();
loadCategories();
loadProducts();
