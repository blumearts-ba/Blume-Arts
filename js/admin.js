import { db, DEFAULT_SETTINGS } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, setDoc, getDoc,
  query, orderBy, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const $ = (s) => document.querySelector(s);
let PRODUCTS = [], CATEGORIES = [], ORDERS = [], REVIEWS = [];
let editingProductId = null;
let editingCategoryId = null;
let uploadedImageBase64 = "";

let currentStoredPinHash = null;

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// 1. PIN CRYPTO HASHING & AUTHENTICATION (PURE PIN ACCESS)
// ============================================================

async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin + "_blume_arts_salt_2026");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function loadAdminPinHash() {
  try {
    const pinRef = doc(db, "settings", "admin_pin");
    const pinSnap = await getDoc(pinRef);

    if (pinSnap.exists() && pinSnap.data().pinHash) {
      currentStoredPinHash = pinSnap.data().pinHash;
    } else {
      // Default initial PIN: 1234
      const defaultHash = await hashPin("1234");
      await setDoc(pinRef, {
        pinHash: defaultHash,
        updatedAt: serverTimestamp()
      });
      currentStoredPinHash = defaultHash;
    }
  } catch (err) {
    console.warn("Error loading PIN settings, using fallback:", err);
    currentStoredPinHash = await hashPin("1234");
  }
}

async function checkAdminPin(inputPin) {
  if (!currentStoredPinHash) await loadAdminPinHash();
  const inputHash = await hashPin(inputPin);
  return inputHash === currentStoredPinHash;
}

if ($("#loginPinBtn")) {
  $("#loginPinBtn").addEventListener("click", async () => {
    await handlePinLogin();
  });
}

if ($("#adminPinInput")) {
  $("#adminPinInput").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") await handlePinLogin();
  });
}

async function handlePinLogin() {
  const pin = $("#adminPinInput").value.trim();
  if ($("#loginError")) $("#loginError").style.display = "none";

  if (!pin) {
    showLoginError("Please enter the Admin PIN.");
    return;
  }

  const isValid = await checkAdminPin(pin);
  if (isValid) {
    sessionStorage.setItem("blume_admin_auth", "true");
    showAdminDashboard();
  } else {
    showLoginError("Incorrect PIN.");
  }
}

function showLoginError(msg) {
  if ($("#loginError")) {
    $("#loginError").textContent = msg;
    $("#loginError").style.display = "block";
  }
}

function showAdminDashboard() {
  $("#loginWrap").style.display = "none";
  $("#adminLayout").classList.add("active");
  if ($("#mobileHeader")) $("#mobileHeader").style.display = "flex";
  if ($("#mobileBottomNav")) $("#mobileBottomNav").style.display = "flex";
  initData();
}

function logoutAdmin() {
  sessionStorage.removeItem("blume_admin_auth");
  $("#adminLayout").classList.remove("active");
  if ($("#mobileHeader")) $("#mobileHeader").style.display = "none";
  if ($("#mobileBottomNav")) $("#mobileBottomNav").style.display = "none";
  $("#loginWrap").style.display = "flex";
  if ($("#adminPinInput")) $("#adminPinInput").value = "";
  if ($("#loginError")) $("#loginError").style.display = "none";
}

if ($("#logoutBtn")) $("#logoutBtn").addEventListener("click", logoutAdmin);
if ($("#mobileLogoutBtn")) $("#mobileLogoutBtn").addEventListener("click", logoutAdmin);

// Show / Hide PIN Toggle
if ($("#togglePinVisibilityBtn")) {
  $("#togglePinVisibilityBtn").addEventListener("click", () => {
    const input = $("#adminPinInput");
    const isPw = input.type === "password";
    input.type = isPw ? "text" : "password";
    $("#eyeIcon").style.opacity = isPw ? "1" : "0.7";
  });
}

if ($("#toggleNewPinBtn")) {
  $("#toggleNewPinBtn").addEventListener("click", () => {
    const input = $("#newPinInput");
    input.type = input.type === "password" ? "text" : "password";
  });
}

// Check Session on page load
window.addEventListener("DOMContentLoaded", async () => {
  await loadAdminPinHash();
  if (sessionStorage.getItem("blume_admin_auth") === "true") {
    showAdminDashboard();
  } else {
    $("#loginWrap").style.display = "flex";
    if ($("#mobileHeader")) $("#mobileHeader").style.display = "none";
    if ($("#mobileBottomNav")) $("#mobileBottomNav").style.display = "none";
  }
});

// ============================================================
// 2. NAVIGATION & TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab-link").forEach(l => l.classList.remove("active"));
  document.querySelectorAll(".tab-view").forEach(v => v.classList.remove("active"));
  
  document.querySelectorAll(`[data-tab="${tabName}"]`).forEach(l => l.classList.add("active"));
  const view = $(`#tab-${tabName}`);
  if (view) view.classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll(".tab-link").forEach(link => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const tab = link.dataset.tab;
    switchTab(tab);
  });
});

// ============================================================
// 3. DATA INITIALIZATION & SNAPSHOT LISTENERS
// ============================================================

function initData() {
  onSnapshot(collection(db, "products"), (snap) => {
    PRODUCTS = []; snap.forEach(d => PRODUCTS.push({ id: d.id, ...d.data() }));
    PRODUCTS.sort((a, b) => {
      const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0);
      const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0);
      return tB - tA;
    });
    renderProductsTable(); renderDashboard(); populateCategorySelect();
  });

  onSnapshot(collection(db, "categories"), (snap) => {
    CATEGORIES = []; snap.forEach(d => CATEGORIES.push({ id: d.id, ...d.data() }));
    renderCategoriesTable(); populateCategorySelect();
  });

  onSnapshot(query(collection(db, "orders"), orderBy("createdAt", "desc")), (snap) => {
    ORDERS = []; snap.forEach(d => ORDERS.push({ id: d.id, ...d.data() }));
    renderOrdersTable(); renderDashboard();
  });

  onSnapshot(collection(db, "reviews"), (snap) => {
    REVIEWS = []; snap.forEach(d => REVIEWS.push({ id: d.id, ...d.data() }));
    renderReviewsTable();
  });

  loadSettingsForm();
}

// ============================================================
// 4. DASHBOARD
// ============================================================

function renderDashboard() {
  if ($("#statTotalProducts")) $("#statTotalProducts").textContent = PRODUCTS.length;
  if ($("#statActiveProducts")) $("#statActiveProducts").textContent = PRODUCTS.filter(p => p.available !== false).length;
  
  const outOfStockCount = PRODUCTS.filter(p => !p.unlimitedStock && Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0)) <= 0).length;
  if ($("#statOutOfStock")) $("#statOutOfStock").textContent = outOfStockCount;

  const lowStockCount = PRODUCTS.filter(p => {
    if (p.unlimitedStock) return false;
    const s = Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0));
    return s > 0 && s <= 3;
  }).length;
  if ($("#statLowStock")) $("#statLowStock").textContent = lowStockCount;

  if ($("#statTotalOrders")) $("#statTotalOrders").textContent = ORDERS.length;
  if ($("#statPendingOrders")) $("#statPendingOrders").textContent = ORDERS.filter(o => o.status !== "Delivered" && o.status !== "Cancelled").length;
  if ($("#statCompletedOrders")) $("#statCompletedOrders").textContent = ORDERS.filter(o => o.status === "Delivered").length;
  const sales = ORDERS.filter(o => o.status !== "Cancelled").reduce((s, o) => s + (o.total || 0), 0);
  if ($("#statTotalSales")) $("#statTotalSales").textContent = "₹" + sales.toLocaleString("en-IN");
}

// ============================================================
// 5. PRODUCTS MANAGEMENT
// ============================================================

function getAdminProductImageSrc(p) {
  if (!p) return "";
  return p.imageUrl || p.imageBase64 || p.imageURL || p.image_url || p.image || "";
}

function compressAndConvertToBase64(file) {
  return new Promise((resolve, reject) => {
    const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!file || !validTypes.includes(file.type.toLowerCase())) {
      return reject(new Error("Unable to process image. Please select JPG, PNG, or WEBP."));
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image file."));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Invalid image format."));
      img.onload = () => {
        const MAX = 800;
        let w = img.width, h = img.height;
        if (w > h && w > MAX) { h = Math.round((h * MAX) / w); w = MAX; }
        else if (h > MAX) { w = Math.round((w * MAX) / h); h = MAX; }

        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        let dataUrl = canvas.toDataURL("image/webp", 0.75);
        if (!dataUrl.startsWith("data:image/webp")) {
          dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        }

        // Check if encoded image is too large for Firestore document (limit ~750KB)
        if (dataUrl.length > 750000) {
          return reject(new Error("Image is too large. Please choose a smaller image."));
        }

        resolve(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function populateCategorySelect() {
  if ($("#fCategory")) {
    $("#fCategory").innerHTML = CATEGORIES.map(c => `<option value="${c.name}">${c.name}</option>`).join("");
  }
}

function renderProductsTable() {
  if (!$("#productsTbody")) return;
  $("#productsTbody").innerHTML = PRODUCTS.map(p => {
    const isUnlimited = Boolean(p.unlimitedStock);
    const stockNum = Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0));
    let stockPill = `<span>${stockNum}</span>`;
    if (isUnlimited) {
      stockPill = `<span class="pill yes" style="background:#e6f4ea;color:#137333;border:1px solid #ceead6">Unlimited</span>`;
    } else if (stockNum <= 0) {
      stockPill = `<span class="pill no">Out of Stock (0)</span>`;
    } else if (stockNum <= 3) {
      stockPill = `<span class="pill warning" style="background:#fff5eb;color:#b7791f;border:1px solid #fbd38d">Low Stock (${stockNum})</span>`;
    }

    return `
      <tr>
        <td><img src="${getAdminProductImageSrc(p)}" onerror="this.style.visibility='hidden'"></td>
        <td><strong>${p.name}</strong></td>
        <td>${p.category || "—"}</td>
        <td>₹${p.price}</td>
        <td>₹${p.deliveryCharge || 0}</td>
        <td>${stockPill}</td>
        <td><span class="pill ${p.available !== false ? "yes" : "no"} toggle-visible" data-id="${p.id}" style="cursor:pointer">${p.available !== false ? "Visible" : "Hidden"}</span></td>
        <td><span class="pill ${p.featured ? "yes" : "no"} toggle-featured" data-id="${p.id}" style="cursor:pointer">${p.featured ? "Yes" : "No"}</span></td>
        <td class="row-actions">
          <span class="icon-action edit-product" data-id="${p.id}" title="Edit"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></span>
          <span class="icon-action delete-product" data-id="${p.id}" title="Delete"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></span>
        </td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="9" style="text-align:center;opacity:.6;padding:30px">No products found. Click "Add Product" to create one.</td></tr>`;

  document.querySelectorAll(".toggle-visible").forEach(el => el.addEventListener("click", () => {
    const p = PRODUCTS.find(x => x.id === el.dataset.id);
    updateDoc(doc(db, "products", p.id), { available: !(p.available !== false), updatedAt: serverTimestamp() });
  }));
  document.querySelectorAll(".toggle-featured").forEach(el => el.addEventListener("click", () => {
    const p = PRODUCTS.find(x => x.id === el.dataset.id);
    updateDoc(doc(db, "products", p.id), { featured: !p.featured, updatedAt: serverTimestamp() });
  }));
  document.querySelectorAll(".edit-product").forEach(el => el.addEventListener("click", () => openProductModal(el.dataset.id)));
  document.querySelectorAll(".delete-product").forEach(el => el.addEventListener("click", () => {
    if (confirm("Delete this product permanently?")) deleteDoc(doc(db, "products", el.dataset.id));
  }));
}

let productImagesSlots = ["", "", "", ""];

function updateSlotPreviewUI(idx) {
  const preview = $("#slotPreview" + idx);
  const removeBtn = document.querySelector(`.remove-slot-img[data-idx="${idx}"]`);
  const src = productImagesSlots[idx];
  if (preview) {
    if (src) {
      preview.src = src;
      preview.style.display = "block";
      if (removeBtn) removeBtn.style.display = "block";
    } else {
      preview.src = "";
      preview.style.display = "none";
      if (removeBtn) removeBtn.style.display = "none";
    }
  }
}

function openProductModal(id) {
  editingProductId = id || null;
  productImagesSlots = ["", "", "", ""];
  $("#customFieldsWrap").innerHTML = "";

  document.querySelectorAll(".f-img-file").forEach(input => input.value = "");

  if (id) {
    const p = PRODUCTS.find(x => x.id === id);
    $("#productModalTitle").textContent = "Edit Product";
    $("#fName").value = p.name || "";
    $("#fPrice").value = p.price || "";
    $("#fDeliveryCharge").value = p.deliveryCharge || 0;
    const isUnlimited = Boolean(p.unlimitedStock);
    if ($("#fUnlimitedStock")) $("#fUnlimitedStock").checked = isUnlimited;
    if ($("#stockQtyGroup")) $("#stockQtyGroup").style.display = isUnlimited ? "none" : "block";
    $("#fStock").value = p.stockQuantity ?? p.stock ?? 10;
    $("#fCategory").value = p.category || "";
    $("#fColors").value = (p.colors || []).join(", ");
    $("#fDescription").value = p.description || "";
    $("#fAvailable").value = String(p.available !== false);
    $("#fFeatured").value = String(!!p.featured);

    if (Array.isArray(p.images) && p.images.length > 0) {
      for (let i = 0; i < 4; i++) {
        productImagesSlots[i] = p.images[i] || "";
      }
    } else {
      productImagesSlots[0] = getAdminProductImageSrc(p);
    }

    for (let i = 0; i < 4; i++) updateSlotPreviewUI(i);

    Object.entries(p.customFields || {}).forEach(([k, v]) => addCustomFieldRow(k, v));
  } else {
    $("#productModalTitle").textContent = "Add Product";
    ["fName", "fPrice", "fColors", "fDescription"].forEach(id => $("#" + id).value = "");
    $("#fDeliveryCharge").value = 0;
    if ($("#fUnlimitedStock")) $("#fUnlimitedStock").checked = false;
    if ($("#stockQtyGroup")) $("#stockQtyGroup").style.display = "block";
    $("#fStock").value = 10;
    $("#fAvailable").value = "true";
    $("#fFeatured").value = "false";

    for (let i = 0; i < 4; i++) updateSlotPreviewUI(i);
  }
  $("#productModalOverlay").classList.add("open");
}

if ($("#fUnlimitedStock")) {
  $("#fUnlimitedStock").addEventListener("change", (e) => {
    const stockGroup = $("#stockQtyGroup");
    if (stockGroup) stockGroup.style.display = e.target.checked ? "none" : "block";
  });
}

if ($("#addProductBtn")) $("#addProductBtn").addEventListener("click", () => openProductModal(null));
if ($("#cancelProductBtn")) $("#cancelProductBtn").addEventListener("click", () => $("#productModalOverlay").classList.remove("open"));

function addCustomFieldRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "custom-field-row";
  row.innerHTML = `<input placeholder="Field name" class="cf-key" value="${key}"><input placeholder="Value" class="cf-val" value="${value}"><span class="icon-action remove-cf"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></span>`;
  row.querySelector(".remove-cf").addEventListener("click", () => row.remove());
  $("#customFieldsWrap").appendChild(row);
}
if ($("#addCustomFieldBtn")) $("#addCustomFieldBtn").addEventListener("click", () => addCustomFieldRow());

// Slot image change listeners
document.querySelectorAll(".f-img-file").forEach(input => {
  input.addEventListener("change", async (e) => {
    const idx = Number(input.dataset.idx);
    const file = e.target.files[0];
    if (!file) return;
    try {
      const base64Data = await compressAndConvertToBase64(file);
      productImagesSlots[idx] = base64Data;
      updateSlotPreviewUI(idx);
    } catch (err) {
      alert(err.message || "Error processing image.");
      input.value = "";
    }
  });
});

// Slot remove image listeners
document.querySelectorAll(".remove-slot-img").forEach(btn => {
  btn.addEventListener("click", () => {
    const idx = Number(btn.dataset.idx);
    productImagesSlots[idx] = "";
    const input = document.querySelector(`.f-img-file[data-idx="${idx}"]`);
    if (input) input.value = "";
    updateSlotPreviewUI(idx);
  });
});

// Save Product
if ($("#saveProductBtn")) {
  $("#saveProductBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    const saveBtn = $("#saveProductBtn");
    if (saveBtn.disabled) return;

    const name = $("#fName").value.trim();
    const rawPrice = $("#fPrice").value;
    const price = Number(rawPrice);
    const deliveryCharge = Number($("#fDeliveryCharge").value) || 0;
    const isUnlimited = $("#fUnlimitedStock") ? $("#fUnlimitedStock").checked : false;

    let stockQuantity = 0;
    if (!isUnlimited) {
      const rawStock = $("#fStock").value.trim();
      const parsedStock = Number(rawStock);
      if (rawStock === "" || isNaN(parsedStock) || !Number.isInteger(parsedStock) || parsedStock < 0) {
        alert("Please enter a valid stock quantity (whole number 0 or greater).");
        return;
      }
      stockQuantity = parsedStock;
    } else {
      stockQuantity = 9999;
    }

    const category = $("#fCategory").value || "";
    const colors = $("#fColors").value.split(",").map(s => s.trim()).filter(Boolean);
    const description = $("#fDescription").value.trim();
    const visible = $("#fAvailable").value === "true";
    const featured = $("#fFeatured").value === "true";

    if (!name || rawPrice === "" || isNaN(price) || price < 0) {
      alert("Please enter a valid product name and price.");
      return;
    }

    if (deliveryCharge < 0) {
      alert("Delivery charge cannot be negative.");
      return;
    }

    saveBtn.disabled = true;
    const originalText = saveBtn.textContent;
    saveBtn.textContent = "Saving Product...";

    try {
      const customFields = {};
      document.querySelectorAll(".custom-field-row").forEach(row => {
        const k = row.querySelector(".cf-key").value.trim();
        const v = row.querySelector(".cf-val").value.trim();
        if (k) customFields[k] = v;
      });

      const existingProduct = editingProductId ? PRODUCTS.find(x => x.id === editingProductId) : null;
      const productDocRef = editingProductId
        ? doc(db, "products", editingProductId)
        : doc(collection(db, "products"));

      const imagesArray = productImagesSlots.filter(Boolean);
      const mainImageUrl = imagesArray[0] || (existingProduct ? getAdminProductImageSrc(existingProduct) : "");

      const productData = {
        name,
        price,
        deliveryCharge,
        unlimitedStock: isUnlimited,
        stockQuantity,
        stock: stockQuantity,
        category,
        colors,
        description,
        images: imagesArray.length > 0 ? imagesArray : (mainImageUrl ? [mainImageUrl] : []),
        imageUrl: mainImageUrl || "",
        imageBase64: mainImageUrl || "",
        visible,
        available: visible,
        featured,
        customFields,
        updatedAt: serverTimestamp(),
      };

      if (!editingProductId || !existingProduct?.createdAt) {
        productData.createdAt = existingProduct?.createdAt || serverTimestamp();
      }

      await setDoc(productDocRef, productData, { merge: true });

      alert("Product saved successfully.");
      $("#productModalOverlay").classList.remove("open");

      editingProductId = null;
      productImagesSlots = ["", "", "", ""];
      for (let i = 0; i < 4; i++) updateSlotPreviewUI(i);

    } catch (error) {
      console.error("Firebase Error:", error);
      alert(`Error saving product: ${error.message}`);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
    }
  });
}

// ============================================================
// 6. CATEGORIES MANAGEMENT
// ============================================================

function renderCategoriesTable() {
  if (!$("#categoriesTbody")) return;
  $("#categoriesTbody").innerHTML = CATEGORIES.map(c => `
    <tr>
      <td><strong>${c.name}</strong></td>
      <td><span class="pill ${!c.hidden ? "yes" : "no"} toggle-cat" data-id="${c.id}" style="cursor:pointer">${!c.hidden ? "Visible" : "Hidden"}</span></td>
      <td class="row-actions">
        <span class="icon-action edit-cat" data-id="${c.id}" title="Edit"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></span>
        <span class="icon-action delete-cat" data-id="${c.id}" title="Delete"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></span>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="3" style="text-align:center;opacity:.6;padding:30px">No categories yet.</td></tr>`;

  document.querySelectorAll(".toggle-cat").forEach(el => el.addEventListener("click", () => {
    const c = CATEGORIES.find(x => x.id === el.dataset.id);
    updateDoc(doc(db, "categories", c.id), { hidden: !c.hidden });
  }));
  document.querySelectorAll(".edit-cat").forEach(el => el.addEventListener("click", () => openCategoryModal(el.dataset.id)));
  document.querySelectorAll(".delete-cat").forEach(el => el.addEventListener("click", () => {
    if (confirm("Delete category?")) deleteDoc(doc(db, "categories", el.dataset.id));
  }));
}

function openCategoryModal(id) {
  editingCategoryId = id || null;
  const c = id ? CATEGORIES.find(x => x.id === id) : null;
  $("#categoryModalTitle").textContent = id ? "Edit Category" : "Add Category";
  $("#cName").value = c ? c.name : "";
  $("#categoryModalOverlay").classList.add("open");
}
if ($("#addCategoryBtn")) $("#addCategoryBtn").addEventListener("click", () => openCategoryModal(null));
if ($("#cancelCategoryBtn")) $("#cancelCategoryBtn").addEventListener("click", () => $("#categoryModalOverlay").classList.remove("open"));
if ($("#saveCategoryBtn")) {
  $("#saveCategoryBtn").addEventListener("click", async () => {
    const name = $("#cName").value.trim();
    if (!name) { alert("Category name is required."); return; }
    if (editingCategoryId) await updateDoc(doc(db, "categories", editingCategoryId), { name });
    else await addDoc(collection(db, "categories"), { name, hidden: false });
    $("#categoryModalOverlay").classList.remove("open");
  });
}

// ============================================================
// 7. ORDERS MANAGEMENT
// ============================================================

const STATUSES = ["Order Placed", "Confirmed", "Preparing", "Packing", "Out for Delivery", "Delivered", "Cancelled"];

async function updateOrderStatus(orderDocId, newStatus) {
  try {
    const orderRef = doc(db, "orders", orderDocId);

    await runTransaction(db, async (transaction) => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists()) throw new Error("Order not found");

      const orderData = orderSnap.data();
      const oldStatus = orderData.status;

      if (oldStatus === newStatus) return;

      if (newStatus === "Cancelled" && oldStatus !== "Cancelled") {
        if (Array.isArray(orderData.products)) {
          for (const item of orderData.products) {
            if (!item.id) continue;
            const pRef = doc(db, "products", item.id);
            const pSnap = await transaction.get(pRef);
            if (pSnap.exists()) {
              const pData = pSnap.data();
              if (!pData.unlimitedStock) {
                const currentStock = Number(pData.stockQuantity !== undefined ? pData.stockQuantity : (pData.stock || 0));
                const newStock = currentStock + Number(item.qty || 1);
                transaction.update(pRef, { stockQuantity: newStock, stock: newStock, updatedAt: serverTimestamp() });
              }
            }
          }
        }
      } else if (oldStatus === "Cancelled" && newStatus !== "Cancelled") {
        if (Array.isArray(orderData.products)) {
          for (const item of orderData.products) {
            if (!item.id) continue;
            const pRef = doc(db, "products", item.id);
            const pSnap = await transaction.get(pRef);
            if (pSnap.exists()) {
              const pData = pSnap.data();
              if (!pData.unlimitedStock) {
                const currentStock = Number(pData.stockQuantity !== undefined ? pData.stockQuantity : (pData.stock || 0));
                const reqQty = Number(item.qty || 1);
                if (currentStock < reqQty) {
                  throw new Error(`Cannot reactivate order. Insufficient stock for "${item.name || item.id}" (${currentStock} available, ${reqQty} required).`);
                }
                const newStock = currentStock - reqQty;
                transaction.update(pRef, { stockQuantity: newStock, stock: newStock, updatedAt: serverTimestamp() });
              }
            }
          }
        }
      }

      const history = Array.isArray(orderData.statusHistory) ? [...orderData.statusHistory] : [];
      history.push({
        status: newStatus,
        timestamp: new Date().toISOString()
      });

      transaction.update(orderRef, {
        status: newStatus,
        statusHistory: history,
        updatedAt: serverTimestamp()
      });
    });

  } catch (err) {
    console.error("Error updating order status:", err);
    alert(err.message || "Failed to update order status.");
    renderOrdersTable();
  }
}

function renderOrdersTable() {
  if (!$("#ordersTbody")) return;

  const searchVal = ($("#orderSearchInput")?.value || "").toLowerCase().trim();
  const filterStatus = $("#orderStatusFilter")?.value || "All";

  const filteredOrders = ORDERS.filter(o => {
    if (filterStatus !== "All" && o.status !== filterStatus) return false;
    if (searchVal) {
      const matchId = (o.orderId || o.id || "").toLowerCase().includes(searchVal);
      const matchCust = (o.customerName || "").toLowerCase().includes(searchVal);
      const matchPhone = (o.mobile || "").toLowerCase().includes(searchVal);
      if (!matchId && !matchCust && !matchPhone) return false;
    }
    return true;
  });

  $("#ordersTbody").innerHTML = filteredOrders.map(o => `
    <tr>
      <td><strong>${o.orderId || o.id}</strong></td>
      <td>${o.customerName || "—"}</td>
      <td>${o.mobile || "—"}</td>
      <td>₹${(o.total || 0).toLocaleString("en-IN")}</td>
      <td>${o.createdAt?.toDate ? o.createdAt.toDate().toLocaleDateString() : "—"}</td>
      <td>
        <span class="pill ${o.paymentMethod === "UPI" ? "yes" : "no"}" style="font-size:.7rem; display:inline-block; margin-bottom:2px;">${o.paymentMethod || "COD"}</span>
        <div style="font-size:.68rem; opacity:.75; max-width:110px; line-height:1.2;">${o.paymentStatus || (o.paymentMethod === "UPI" ? "Pending Verification" : "Pay on Delivery")}</div>
        ${o.paymentMethod === "UPI" ? `
          <div style="margin-top:4px;">
            ${o.paymentScreenshot ? `
              <span class="pill yes" style="font-size:.62rem; display:inline-block; margin-bottom:3px;">Screenshot Uploaded</span><br>
              <button class="btn outline sm view-screenshot-btn" data-id="${o.id}" style="font-size:.68rem; padding:2px 8px; line-height:1.4;">View Screenshot</button>
            ` : `
              <span class="pill no" style="font-size:.62rem; display:inline-block;">Screenshot Not Uploaded</span>
            `}
          </div>
        ` : ""}
      </td>
      <td>
        <select class="status-select" data-id="${o.id}">
          ${STATUSES.map(s => `<option value="${s}" ${s === o.status ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </td>
      <td><span class="icon-action view-order" data-id="${o.id}" title="View Order"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></span></td>
    </tr>
  `).join("") || `<tr><td colspan="8" style="text-align:center;opacity:.6;padding:30px">No orders matching criteria.</td></tr>`;

  document.querySelectorAll(".status-select").forEach(sel => {
    sel.addEventListener("change", async () => {
      await updateOrderStatus(sel.dataset.id, sel.value);
    });
  });
  document.querySelectorAll(".view-order").forEach(el => el.addEventListener("click", () => openOrderModal(el.dataset.id)));
  document.querySelectorAll(".view-screenshot-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const o = ORDERS.find(x => x.id === btn.dataset.id);
      if (o && o.paymentScreenshot) openScreenshotViewerModal(o);
    });
  });
}

if ($("#orderSearchInput")) $("#orderSearchInput").addEventListener("input", renderOrdersTable);
if ($("#orderStatusFilter")) $("#orderStatusFilter").addEventListener("change", renderOrdersTable);

// ------------------------------------------------------------
// PAYMENT SCREENSHOT VIEWER MODAL
// ------------------------------------------------------------
let viewingScreenshotOrderId = null;

function openScreenshotViewerModal(order) {
  if (!order) return;
  viewingScreenshotOrderId = order.id;
  if ($("#viewerOrderId")) $("#viewerOrderId").textContent = order.orderId || order.id;
  if ($("#viewerOrderAmount")) $("#viewerOrderAmount").textContent = "₹" + (order.total || 0).toLocaleString("en-IN");
  if ($("#viewerPaymentStatus")) {
    const isPaid = (order.paymentStatus || "").includes("Verified");
    $("#viewerPaymentStatus").textContent = order.paymentStatus || "Payment Review Pending";
    $("#viewerPaymentStatus").className = "pill " + (isPaid ? "yes" : "no");
  }

  const driveMetaBox = $("#viewerDriveMetaBox");
  const drivePrivateNotice = $("#viewerDrivePrivateNotice");
  const driveFileName = $("#viewerDriveFileName");
  const driveFileId = $("#viewerDriveFileId");
  const driveDirectBtn = $("#viewerDriveDirectBtn");
  const imgEl = $("#viewerScreenshotImg");
  const openTabBtn = $("#viewerOpenTabBtn");

  const screenshotUrl = order.paymentScreenshot || order.paymentScreenshotDrive?.webViewLink || "";

  if (order.paymentScreenshotDrive) {
    if (driveMetaBox) driveMetaBox.style.display = "block";
    if (drivePrivateNotice) drivePrivateNotice.style.display = "block";
    if (driveFileName) driveFileName.textContent = order.paymentScreenshotDrive.fileName || "Payment Screenshot";
    if (driveFileId) driveFileId.textContent = order.paymentScreenshotDrive.fileId || "—";
    if (driveDirectBtn) driveDirectBtn.href = order.paymentScreenshotDrive.webViewLink || screenshotUrl;
    if (openTabBtn) openTabBtn.href = order.paymentScreenshotDrive.webViewLink || screenshotUrl;
  } else {
    if (driveMetaBox) driveMetaBox.style.display = "none";
    if (drivePrivateNotice) drivePrivateNotice.style.display = "none";
    if (openTabBtn) openTabBtn.href = screenshotUrl || "#";
  }

  if (imgEl) {
    imgEl.style.display = "block";
    imgEl.src = screenshotUrl;
    imgEl.onerror = () => {
      if (order.paymentScreenshotDrive) {
        imgEl.style.display = "none";
      }
    };
  }

  if ($("#screenshotViewerModalOverlay")) {
    $("#screenshotViewerModalOverlay").classList.add("open");
  }
}

function closeScreenshotViewerModal() {
  if ($("#screenshotViewerModalOverlay")) {
    $("#screenshotViewerModalOverlay").classList.remove("open");
  }
  viewingScreenshotOrderId = null;
}

if ($("#closeScreenshotViewer")) $("#closeScreenshotViewer").addEventListener("click", closeScreenshotViewerModal);
if ($("#closeScreenshotViewerBtn")) $("#closeScreenshotViewerBtn").addEventListener("click", closeScreenshotViewerModal);
if ($("#screenshotViewerModalOverlay")) {
  $("#screenshotViewerModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "screenshotViewerModalOverlay") closeScreenshotViewerModal();
  });
}

if ($("#viewerMarkPaidBtn")) {
  $("#viewerMarkPaidBtn").addEventListener("click", async () => {
    if (!viewingScreenshotOrderId) return;
    const btn = $("#viewerMarkPaidBtn");
    btn.disabled = true;
    btn.textContent = "Updating...";
    try {
      await updateDoc(doc(db, "orders", viewingScreenshotOrderId), {
        paymentStatus: "Payment Verified / Paid",
        updatedAt: serverTimestamp()
      });
      const order = ORDERS.find(x => x.id === viewingScreenshotOrderId);
      if (order) order.paymentStatus = "Payment Verified / Paid";
      if ($("#viewerPaymentStatus")) {
        $("#viewerPaymentStatus").textContent = "Payment Verified / Paid";
        $("#viewerPaymentStatus").className = "pill yes";
      }
      alert("Payment status updated to: Payment Verified / Paid");
      renderOrdersTable();
      closeScreenshotViewerModal();
    } catch (err) {
      alert("Failed to update payment status: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Mark Payment Verified";
    }
  });
}

function openOrderModal(id) {
  const o = ORDERS.find(x => x.id === id);
  if (!o) return;
  const addr = o.address || {};
  const history = o.statusHistory || [];

  $("#orderModalBody").innerHTML = `
    <h3>Order ${o.orderId || o.id}</h3>
    <p style="margin-bottom:14px;opacity:.7;font-size:.85rem">${o.createdAt?.toDate ? o.createdAt.toDate().toLocaleString() : ""}</p>
    <div class="form-group"><label>Customer</label><p><strong>${o.customerName}</strong> · ${o.mobile}${o.whatsapp ? " · WA: " + o.whatsapp : ""}${o.email ? " · " + o.email : ""}</p></div>
    <div class="form-group"><label>Delivery Address</label><p>${addr.house || ""}, ${addr.street || ""}, ${addr.area || ""}, ${addr.city || ""}, ${addr.district || ""}, ${addr.state || ""} - ${addr.pincode || ""}</p></div>
    <div class="form-group"><label>Products</label>
      ${(o.products || []).map(p => `<div class="custom-field-row" style="justify-content:space-between"><span>${p.name} ${p.color ? "(" + p.color + ")" : ""} × ${p.qty}</span><span>₹${(p.price * p.qty).toLocaleString("en-IN")}</span></div>`).join("")}
    </div>
    <div class="form-group"><label>Subtotal</label><p>₹${(o.subtotal || o.total || 0).toLocaleString("en-IN")}</p></div>
    <div class="form-group"><label>Delivery Charge</label><p>₹${o.deliveryCharge || 0}</p></div>
    <div class="form-group"><label>Final Total</label><p style="font-weight:600;color:var(--rose-deep);font-size:1.1rem;">₹${(o.total || 0).toLocaleString("en-IN")}</p></div>
    ${o.notes ? `<div class="form-group"><label>Customer Notes</label><p>${o.notes}</p></div>` : ""}

    <div class="form-group" style="background:var(--cream); padding:12px; border-radius:10px; border:1px solid var(--beige); margin-top:12px;">
      <label style="font-weight:600; color:var(--rose-deep); margin-bottom:6px;">Payment Verification & Details</label>
      <div style="font-size:.82rem; margin-bottom:6px;">
        <strong>Method:</strong> ${o.paymentMethod || "COD"} | <strong>Status:</strong> <span class="pill ${o.paymentStatus?.includes('Verified') ? 'yes' : 'no'}" style="font-size:.7rem;">${o.paymentStatus || (o.paymentMethod === 'UPI' ? 'Payment Pending Verification' : 'Pending (COD)')}</span>
      </div>
      ${o.upiUtr ? `<div style="font-size:.8rem; margin-bottom:6px;"><strong>UPI Reference / UTR:</strong> <code>${o.upiUtr}</code></div>` : ""}
      
      ${o.paymentMethod === "UPI" ? `
        <div style="margin:10px 0; padding:10px; background:#fff; border-radius:8px; border:1px solid var(--beige);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <strong style="font-size:.78rem;">Payment Screenshot Evidence:</strong>
            <span class="pill ${o.paymentScreenshot ? 'yes' : 'no'}" style="font-size:.68rem;">${o.paymentScreenshot ? 'Screenshot Uploaded' : 'Screenshot Not Uploaded'}</span>
          </div>
          ${o.paymentScreenshot ? `
            <div style="display:flex; align-items:center; gap:12px; margin-top:6px;">
              <img src="${o.paymentScreenshot}" alt="Payment Evidence" id="modalThumbPreview" style="width:70px; height:70px; border-radius:8px; border:1px solid var(--beige); object-fit:cover; cursor:pointer;" onerror="this.style.display='none'">
              <div style="flex:1;">
                <button type="button" class="btn outline sm" id="btnModalViewScreenshot" style="font-size:.75rem; padding:4px 10px;">View Payment Screenshot</button>
                ${o.paymentScreenshotDrive ? `
                  <div style="margin-top:4px; font-size:.72rem; color:#1d4ed8;">
                    <strong>Google Drive:</strong> ${o.paymentScreenshotDrive.fileName || 'Screenshot'}
                    <a href="${o.paymentScreenshotDrive.webViewLink || o.paymentScreenshot}" target="_blank" style="margin-left:6px; color:#2563eb; text-decoration:underline;">Open in Drive ↗</a>
                  </div>
                ` : `
                  <div style="font-size:.7rem; opacity:.7; margin-top:4px;">Inspect full image with Order ID and amount</div>
                `}
              </div>
            </div>
          ` : `
            <div style="font-size:.78rem; color:#b91c1c; margin-top:4px;">No payment screenshot uploaded yet by customer.</div>
          `}
        </div>
      ` : ""}

      <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
        <select id="adminUpdatePaymentStatusSelect" style="padding:6px 10px; font-size:.8rem; border-radius:8px; border:1px solid var(--beige);">
          <option value="Payment Pending Verification" ${o.paymentStatus === "Payment Pending Verification" ? "selected" : ""}>Payment Pending Verification</option>
          <option value="Payment Verified / Paid" ${o.paymentStatus === "Payment Verified / Paid" ? "selected" : ""}>Payment Verified / Paid</option>
          <option value="Payment Failed / Rejected" ${o.paymentStatus === "Payment Failed / Rejected" ? "selected" : ""}>Payment Failed / Rejected</option>
          <option value="Pending (Cash on Delivery)" ${o.paymentStatus === "Pending (Cash on Delivery)" ? "selected" : ""}>Pending (Cash on Delivery)</option>
          <option value="Cash Collected (Delivered)" ${o.paymentStatus === "Cash Collected (Delivered)" ? "selected" : ""}>Cash Collected (Delivered)</option>
        </select>
        <button class="btn sm" id="btnAdminSavePaymentStatus" style="font-size:.75rem;">Update Payment Status</button>
      </div>
    </div>

    ${history.length > 0 ? `
      <div class="form-group"><label>Status History</label>
        <ul style="font-size:.82rem; padding-left:20px; line-height:1.6; opacity:.85; max-height:100px; overflow-y:auto;">
          ${history.map(h => `<li><strong>${h.status}</strong> — ${h.timestamp ? new Date(h.timestamp).toLocaleString() : ""}</li>`).join("")}
        </ul>
      </div>
    ` : ""}
    <div class="form-group" style="margin-top:16px; border-top:1px solid var(--beige); padding-top:12px;">
      <label style="font-weight:600; color:var(--rose-deep);">Messages to Customer</label>
      <div id="adminSellerMessagesList" style="max-height:140px; overflow-y:auto; font-size:.82rem; margin-bottom:10px; display:flex; flex-direction:column; gap:6px;"></div>
      <div style="display:flex; gap:8px;">
        <input id="adminSellerMsgInput" placeholder="Type a custom message for customer..." style="flex:1; padding:8px 12px; border:1px solid var(--beige); border-radius:8px; font-size:.82rem;">
        <button class="btn sm" id="sendSellerMsgBtn">Send Message</button>
      </div>
    </div>
    <div class="form-actions"><button class="btn outline" id="closeOrderModal">Close</button></div>
  `;
  $("#orderModalOverlay").classList.add("open");
  $("#closeOrderModal").addEventListener("click", () => $("#orderModalOverlay").classList.remove("open"));

  if ($("#btnModalViewScreenshot")) {
    $("#btnModalViewScreenshot").addEventListener("click", () => openScreenshotViewerModal(o));
  }
  if ($("#modalThumbPreview")) {
    $("#modalThumbPreview").addEventListener("click", () => openScreenshotViewerModal(o));
  }

  if ($("#btnAdminSavePaymentStatus")) {
    $("#btnAdminSavePaymentStatus").addEventListener("click", async () => {
      const newPayStatus = $("#adminUpdatePaymentStatusSelect")?.value;
      if (!newPayStatus) return;
      try {
        await updateDoc(doc(db, "orders", o.id), {
          paymentStatus: newPayStatus,
          updatedAt: serverTimestamp()
        });
        o.paymentStatus = newPayStatus;
        alert("Payment status updated to: " + newPayStatus);
        renderOrdersTable();
      } catch (err) {
        alert("Failed to update payment status: " + err.message);
      }
    });
  }

  // Real-Time listener for seller messages on this order (with Edit & Delete support)
  const msgList = $("#adminSellerMessagesList");
  if (msgList) {
    onSnapshot(collection(db, "orders", o.id, "sellerMessages"), (snap) => {
      if (snap.empty) {
        msgList.innerHTML = `<p style="opacity:.6; font-style:italic; padding:6px 0;">No messages sent yet.</p>`;
        return;
      }
      const docs = [];
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
      docs.sort((a, b) => {
        const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.timestamp ? new Date(a.timestamp).getTime() : 0);
        const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.timestamp ? new Date(b.timestamp).getTime() : 0);
        return tA - tB;
      });

      msgList.innerHTML = docs.map(data => {
        const timeStr = data.createdAt?.toDate ? data.createdAt.toDate().toLocaleString() : (data.timestamp ? new Date(data.timestamp).toLocaleString() : "");
        const safeText = escapeHtml(data.messageText);
        return `
          <div class="seller-msg-card-item" id="msgCard_${data.id}" style="background:var(--cream); padding:8px 10px; border-radius:8px; border:1px solid var(--beige);">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
              <div style="flex:1;">
                <div style="display:flex; align-items:center; gap:6px;">
                  <strong style="color:var(--rose-deep); font-size:.78rem;">Seller:</strong>
                  <span style="opacity:.6; font-size:.68rem;">${timeStr}</span>
                </div>
                <div class="msg-display-text" id="msgDisplay_${data.id}" style="font-size:.84rem; color:var(--brown); margin-top:2px; word-break:break-word;">
                  ${safeText}
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                <button type="button" class="btn-edit-msg" data-id="${data.id}" title="Edit Message" style="background:none; border:none; cursor:pointer; padding:4px; color:var(--dusty-rose); display:inline-flex; align-items:center;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button type="button" class="btn-delete-msg" data-id="${data.id}" title="Delete Message" style="background:none; border:none; cursor:pointer; padding:4px; color:#c0524f; display:inline-flex; align-items:center;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
              </div>
            </div>

            <!-- Inline Edit Form -->
            <div class="msg-edit-panel" id="msgEditPanel_${data.id}" style="display:none; margin-top:8px; padding-top:6px; border-top:1px dashed var(--beige);">
              <div style="display:flex; gap:6px;">
                <input type="text" class="msg-edit-input" id="msgInput_${data.id}" value="${safeText}" style="flex:1; padding:6px 10px; font-size:.8rem; border:1px solid var(--beige); border-radius:6px; background:#fff;">
                <button type="button" class="btn sm btn-save-msg" data-id="${data.id}" style="padding:4px 10px; font-size:.75rem;">Save</button>
                <button type="button" class="btn outline sm btn-cancel-msg" data-id="${data.id}" style="padding:4px 10px; font-size:.75rem;">Cancel</button>
              </div>
            </div>
          </div>
        `;
      }).join("");

      // Wire up Edit buttons
      msgList.querySelectorAll(".btn-edit-msg").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.id;
          const panel = $(`#msgEditPanel_${id}`);
          const display = $(`#msgDisplay_${id}`);
          if (panel) {
            panel.style.display = "block";
            const input = $(`#msgInput_${id}`);
            if (input) input.focus();
          }
          if (display) display.style.display = "none";
        });
      });

      // Wire up Cancel buttons
      msgList.querySelectorAll(".btn-cancel-msg").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.id;
          const panel = $(`#msgEditPanel_${id}`);
          const display = $(`#msgDisplay_${id}`);
          if (panel) panel.style.display = "none";
          if (display) display.style.display = "block";
        });
      });

      // Wire up Save buttons
      msgList.querySelectorAll(".btn-save-msg").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          const input = $(`#msgInput_${id}`);
          const newText = input ? input.value.trim() : "";
          if (!newText) {
            alert("Message text cannot be empty.");
            return;
          }
          btn.disabled = true;
          btn.textContent = "...";
          try {
            await updateDoc(doc(db, "orders", o.id, "sellerMessages", id), {
              messageText: newText,
              updatedAt: serverTimestamp()
            });
          } catch (err) {
            alert("Failed to update message: " + err.message);
            btn.disabled = false;
            btn.textContent = "Save";
          }
        });
      });

      // Wire up Delete buttons
      msgList.querySelectorAll(".btn-delete-msg").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!confirm("Are you sure you want to delete this message?")) return;
          btn.disabled = true;
          try {
            await deleteDoc(doc(db, "orders", o.id, "sellerMessages", id));
          } catch (err) {
            alert("Failed to delete message: " + err.message);
            btn.disabled = false;
          }
        });
      });
    });
  }

  const sendNewMessage = async () => {
    const input = $("#adminSellerMsgInput");
    const sendBtn = $("#sendSellerMsgBtn");
    const text = input ? input.value.trim() : "";
    if (!text) return;
    if (sendBtn) sendBtn.disabled = true;
    try {
      await addDoc(collection(db, "orders", o.id, "sellerMessages"), {
        orderId: o.orderId || o.id,
        messageText: text,
        sender: "seller",
        createdAt: serverTimestamp()
      });
      if (input) input.value = "";
    } catch (err) {
      alert("Failed to send message: " + err.message);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  };

  if ($("#sendSellerMsgBtn")) {
    $("#sendSellerMsgBtn").addEventListener("click", sendNewMessage);
  }
  if ($("#adminSellerMsgInput")) {
    $("#adminSellerMsgInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendNewMessage();
      }
    });
  }
}

// ============================================================
// 7.5 REVIEWS MANAGEMENT
// ============================================================

function renderReviewsTable() {
  if (!$("#reviewsTbody")) return;

  $("#reviewsTbody").innerHTML = REVIEWS.map(r => {
    const starStr = "★".repeat(r.rating || 5) + "☆".repeat(5 - (r.rating || 5));
    const dateStr = r.createdAt?.toDate ? r.createdAt.toDate().toLocaleDateString() : (r.date || "—");

    return `
      <tr>
        <td><strong>${r.productName || r.productId}</strong></td>
        <td>${r.customerName || "Customer"} (${r.customerMobile || "—"})</td>
        <td><span style="color:#f59e0b;font-weight:600">${starStr} (${r.rating}/5)</span></td>
        <td style="max-width:300px;word-break:break-word;">${r.comment || "No comment."}</td>
        <td><code>${r.orderId}</code></td>
        <td>${dateStr}</td>
        <td class="row-actions">
          <span class="icon-action delete-review" data-id="${r.id}" data-pid="${r.productId}" title="Delete Review">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </span>
        </td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="7" style="text-align:center;opacity:.6;padding:30px">No customer reviews submitted yet.</td></tr>`;

  document.querySelectorAll(".delete-review").forEach(el => {
    el.addEventListener("click", async () => {
      if (confirm("Delete this review permanently?")) {
        await deleteReview(el.dataset.id, el.dataset.pid);
      }
    });
  });
}

async function deleteReview(reviewId, productId) {
  try {
    await deleteDoc(doc(db, "reviews", reviewId));
    
    // Recalculate avgRating and reviewCount for product
    if (productId) {
      const pReviews = REVIEWS.filter(r => r.id !== reviewId && r.productId === productId);
      const reviewCount = pReviews.length;
      let avgRating = 0;
      if (reviewCount > 0) {
        const sum = pReviews.reduce((acc, curr) => acc + Number(curr.rating || 5), 0);
        avgRating = Number((sum / reviewCount).toFixed(1));
      }
      await updateDoc(doc(db, "products", productId), {
        avgRating,
        reviewCount,
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    console.error("Error deleting review:", err);
    alert("Failed to delete review: " + err.message);
  }
}


// ============================================================
// 8. SETTINGS MANAGEMENT
// ============================================================

export function extractGoogleDriveFolderId(input) {
  if (!input || typeof input !== "string") return null;
  const str = input.trim();
  const matchFolders = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (matchFolders && matchFolders[1]) return matchFolders[1];
  const matchIdParam = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (matchIdParam && matchIdParam[1]) return matchIdParam[1];
  if (/^[a-zA-Z0-9_-]{20,50}$/.test(str)) {
    return str;
  }
  return null;
}

function updateDriveConfigUI(folderUrl, scriptUrl) {
  const extractedId = extractGoogleDriveFolderId(folderUrl);
  const badge = $("#driveFolderIdBadge");
  const text = $("#driveFolderIdText");
  const pill = $("#driveConfigStatusPill");

  if (!folderUrl) {
    if (badge) badge.style.display = "none";
    if (text) {
      text.textContent = "Enter your Google Drive folder link above.";
      text.style.color = "inherit";
    }
  } else if (extractedId) {
    if (badge) {
      badge.style.display = "inline-block";
      badge.className = "pill yes";
      badge.textContent = `Folder ID: ${extractedId}`;
    }
    if (text) {
      text.textContent = "✓ Valid Google Drive destination folder.";
      text.style.color = "#047857";
    }
  } else {
    if (badge) {
      badge.style.display = "inline-block";
      badge.className = "pill no";
      badge.textContent = "Invalid Format";
    }
    if (text) {
      text.textContent = "⚠ Please paste a valid Google Drive folder URL (e.g. https://drive.google.com/drive/folders/...)";
      text.style.color = "#b91c1c";
    }
  }

  if (pill) {
    if (extractedId && scriptUrl && scriptUrl.startsWith("https://script.google.com/")) {
      pill.className = "pill yes";
      pill.style.background = "";
      pill.style.color = "";
      pill.textContent = "✓ Google Drive Connected";
    } else if (extractedId) {
      pill.className = "pill";
      pill.style.background = "#fef3c7";
      pill.style.color = "#92400e";
      pill.textContent = "⚠ Apps Script URL Needed";
    } else {
      pill.className = "pill no";
      pill.style.background = "";
      pill.style.color = "";
      pill.textContent = "Not Configured";
    }
  }
}

async function loadSettingsForm() {
  let s = { ...DEFAULT_SETTINGS };
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    if (snap.exists()) s = { ...s, ...snap.data() };
  } catch (e) { console.warn(e.message); }
  if ($("#setBusinessName")) $("#setBusinessName").value = s.businessName || "";
  if ($("#setPhone")) $("#setPhone").value = s.phone || "";
  if ($("#setWhatsapp")) $("#setWhatsapp").value = s.whatsapp || "";
  if ($("#setUpiId")) $("#setUpiId").value = s.upiId || DEFAULT_SETTINGS.upiId || "";
  if ($("#setEmail")) $("#setEmail").value = s.email || "";
  if ($("#setInstagram")) $("#setInstagram").value = s.instagram || "";
  if ($("#setInstagramUrl")) $("#setInstagramUrl").value = s.instagramUrl || "";
  if ($("#setAddress")) $("#setAddress").value = s.address || "";
  if ($("#setDescription")) $("#setDescription").value = s.description || "";
  if ($("#setDeliveryInfo")) $("#setDeliveryInfo").value = s.deliveryInfo || "";
  if ($("#setFooterText")) $("#setFooterText").value = s.footerText || "";
  if ($("#setGoogleDriveFolderUrl")) $("#setGoogleDriveFolderUrl").value = s.googleDriveFolderUrl || "";
  if ($("#setGoogleDriveScriptUrl")) $("#setGoogleDriveScriptUrl").value = s.googleDriveScriptUrl || "";
  if ($("#setCloudinaryCloudName")) $("#setCloudinaryCloudName").value = s.cloudinaryCloudName || "";
  if ($("#setCloudinaryUploadPreset")) $("#setCloudinaryUploadPreset").value = s.cloudinaryUploadPreset || "";
  if ($("#setImgbbApiKey")) $("#setImgbbApiKey").value = s.imgbbApiKey || "";

  updateDriveConfigUI(s.googleDriveFolderUrl || "", s.googleDriveScriptUrl || "");
}

if ($("#setGoogleDriveFolderUrl")) {
  $("#setGoogleDriveFolderUrl").addEventListener("input", (e) => {
    updateDriveConfigUI(e.target.value.trim(), $("#setGoogleDriveScriptUrl")?.value.trim() || "");
  });
}
if ($("#setGoogleDriveScriptUrl")) {
  $("#setGoogleDriveScriptUrl").addEventListener("input", (e) => {
    updateDriveConfigUI($("#setGoogleDriveFolderUrl")?.value.trim() || "", e.target.value.trim());
  });
}

if ($("#btnToggleDriveSetupGuide")) {
  $("#btnToggleDriveSetupGuide").addEventListener("click", () => {
    const guide = $("#driveSetupGuide");
    if (!guide) return;
    const isHidden = guide.style.display === "none";
    guide.style.display = isHidden ? "block" : "none";
    $("#btnToggleDriveSetupGuide").textContent = isHidden ? "📖 Hide Setup Guide" : "📖 View 1-Minute Setup Guide";
  });
}

const APPS_SCRIPT_SNIPPET = `// See google-apps-script/Code.gs for the full script with detailed setup steps.
function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var folder = DriveApp.getFolderById(data.folderId);
  var blob = Utilities.newBlob(Utilities.base64Decode(data.base64Data.replace(/^data:[^;]+;base64,/, '')), data.mimeType, data.fileName);
  var file = folder.createFile(blob);
  file.setDescription('Blume Arts Order: ' + data.orderId + ' | ' + new Date().toISOString());
  return ContentService.createTextOutput(JSON.stringify({ success: true, fileId: file.getId(), fileName: data.fileName, folderId: data.folderId, webViewLink: file.getUrl() })).setMimeType(ContentService.MimeType.JSON);
}`;

if ($("#appsScriptCodeBlock")) {
  $("#appsScriptCodeBlock").textContent = APPS_SCRIPT_SNIPPET;
}

if ($("#btnCopyAppsScript")) {
  $("#btnCopyAppsScript").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(APPS_SCRIPT_SNIPPET);
      $("#btnCopyAppsScript").textContent = "✓ Copied!";
      setTimeout(() => { if ($("#btnCopyAppsScript")) $("#btnCopyAppsScript").textContent = "Copy Script"; }, 2000);
    } catch (e) {
      alert("Please copy manually from google-apps-script/Code.gs");
    }
  });
}

if ($("#saveDriveSettingsBtn")) {
  $("#saveDriveSettingsBtn").addEventListener("click", async () => {
    if (sessionStorage.getItem("blume_admin_auth") !== "true") {
      alert("Unauthorized: Only authenticated admins can modify store settings.");
      return;
    }

    const folderUrl = $("#setGoogleDriveFolderUrl")?.value.trim() || "";
    const scriptUrl = $("#setGoogleDriveScriptUrl")?.value.trim() || "";

    if (folderUrl) {
      const extractedId = extractGoogleDriveFolderId(folderUrl);
      if (!extractedId) {
        alert("Invalid Google Drive Folder URL. Please paste a valid folder link (e.g. https://drive.google.com/drive/folders/...) or folder ID.");
        return;
      }
    }

    if (scriptUrl && !scriptUrl.startsWith("https://script.google.com/")) {
      alert("Warning: Google Apps Script Web App URLs typically start with 'https://script.google.com/macros/s/.../exec'. Please check your Web App URL.");
    }

    const btn = $("#saveDriveSettingsBtn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      const extractedFolderId = extractGoogleDriveFolderId(folderUrl) || "";
      const data = {
        googleDriveFolderUrl: folderUrl,
        googleDriveFolderId: extractedFolderId,
        googleDriveScriptUrl: scriptUrl
      };
      await setDoc(doc(db, "settings", "business"), data, { merge: true });
      updateDriveConfigUI(folderUrl, scriptUrl);
      alert("Google Drive destination settings saved successfully.");
    } catch (err) {
      alert("Failed to save Google Drive destination: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Google Drive Destination";
    }
  });
}

if ($("#saveSettingsBtn")) {
  $("#saveSettingsBtn").addEventListener("click", async () => {
    if (sessionStorage.getItem("blume_admin_auth") !== "true") {
      alert("Unauthorized: Only authenticated admins can modify store settings.");
      return;
    }
    const folderUrl = $("#setGoogleDriveFolderUrl")?.value.trim() || "";
    const data = {
      businessName: $("#setBusinessName").value.trim(),
      phone: $("#setPhone").value.trim(),
      whatsapp: $("#setWhatsapp").value.trim(),
      upiId: ($("#setUpiId")?.value.trim()) || DEFAULT_SETTINGS.upiId,
      email: $("#setEmail").value.trim(),
      instagram: $("#setInstagram").value.trim(),
      instagramUrl: $("#setInstagramUrl").value.trim(),
      address: $("#setAddress").value.trim(),
      description: $("#setDescription").value.trim(),
      deliveryInfo: $("#setDeliveryInfo").value.trim(),
      footerText: $("#setFooterText").value.trim(),
      googleDriveFolderUrl: folderUrl,
      googleDriveFolderId: extractGoogleDriveFolderId(folderUrl) || "",
      googleDriveScriptUrl: $("#setGoogleDriveScriptUrl")?.value.trim() || "",
      cloudinaryCloudName: $("#setCloudinaryCloudName")?.value.trim() || "",
      cloudinaryUploadPreset: $("#setCloudinaryUploadPreset")?.value.trim() || "",
      imgbbApiKey: $("#setImgbbApiKey")?.value.trim() || ""
    };
    try {
      await setDoc(doc(db, "settings", "business"), data, { merge: true });
      alert("Settings saved successfully.");
    } catch (e) {
      alert("Could not save settings: " + e.message);
    }
  });
}

if ($("#saveImageHostSettingsBtn")) {
  $("#saveImageHostSettingsBtn").addEventListener("click", async () => {
    if (sessionStorage.getItem("blume_admin_auth") !== "true") {
      alert("Unauthorized: Only authenticated admins can modify store settings.");
      return;
    }
    const data = {
      cloudinaryCloudName: $("#setCloudinaryCloudName")?.value.trim() || "",
      cloudinaryUploadPreset: $("#setCloudinaryUploadPreset")?.value.trim() || "",
      imgbbApiKey: $("#setImgbbApiKey")?.value.trim() || ""
    };
    try {
      await setDoc(doc(db, "settings", "business"), data, { merge: true });
      alert("Image hosting settings saved successfully.");
    } catch (e) {
      alert("Could not save image hosting settings: " + e.message);
    }
  });
}

// ============================================================
// 9. ACCESS MANAGEMENT (CHANGE ADMIN PIN)
// ============================================================

if ($("#updatePinBtn")) {
  $("#updatePinBtn").addEventListener("click", async () => {
    const newPin = $("#newPinInput").value.trim();
    const confirmPin = $("#confirmPinInput").value.trim();
    $("#accessError").style.display = "none";
    $("#accessSuccess").style.display = "none";

    if (!newPin || newPin.length < 4 || newPin.length > 8 || !/^\d+$/.test(newPin)) {
      showAccessError("PIN must be 4 to 8 numeric digits.");
      return;
    }

    if (newPin !== confirmPin) {
      showAccessError("New PIN and Confirm PIN do not match.");
      return;
    }

    try {
      const newHash = await hashPin(newPin);
      await setDoc(doc(db, "settings", "admin_pin"), {
        pinHash: newHash,
        updatedAt: serverTimestamp()
      });
      currentStoredPinHash = newHash;

      $("#accessSuccess").textContent = "Admin PIN updated successfully! The new PIN is active immediately.";
      $("#accessSuccess").style.display = "block";
      $("#newPinInput").value = "";
      $("#confirmPinInput").value = "";

      setTimeout(() => { $("#accessSuccess").style.display = "none"; }, 5000);
    } catch (err) {
      showAccessError("Failed to update PIN: " + err.message);
    }
  });
}

function showAccessError(msg) {
  $("#accessError").textContent = msg;
  $("#accessError").style.display = "block";
}
