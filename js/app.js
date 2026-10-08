import { db, DEFAULT_SETTINGS } from "./firebase-config.js";
import {
  collection, onSnapshot, addDoc, serverTimestamp, doc, getDoc
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

const $ = (sel) => document.querySelector(sel);
const money = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

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
        deliveryCharge: isNaN(deliveryCharge) ? 0 : deliveryCharge
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
    return `
      <div class="product-card" style="animation-delay:${i * 0.04}s" data-id="${p.id}">
        <div class="product-img-wrap">
          <img src="${imageSource}" alt="${cleanName}" loading="lazy">
          ${p.featured ? '<span class="product-badge">Featured</span>' : ""}
        </div>
        <div class="product-info">
          <h3>${cleanName}</h3>
          <div class="desc">${(removeEmojis(p.description) || "").slice(0, 50)}</div>
          <div class="price-row">
            <span class="price">${money(p.price)}</span>
            <span class="stock-tag ${p.stock === 0 ? "out" : ""}">${p.stock === 0 ? "Out of Stock" : "In Stock"}</span>
          </div>
          <div class="card-actions">
            <button class="btn btn-outline add-cart" data-id="${p.id}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
              Add to Cart
            </button>
            <button class="btn btn-primary buy-now" data-id="${p.id}">Buy Now</button>
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

// ---------- PRODUCT MODAL ----------
function openProductModal(id) {
  activeProduct = PRODUCTS.find(p => p.id === id);
  if (!activeProduct) return;
  pdQty = 1;
  pdSelectedColor = (activeProduct.colors || [])[0] || null;

  const imageSource = getProductImage(activeProduct);
  $("#pdImage").src = imageSource;
  $("#pdName").textContent = removeEmojis(activeProduct.name);
  $("#pdPrice").textContent = money(activeProduct.price);
  $("#pdDesc").textContent = removeEmojis(activeProduct.description) || "";
  $("#pdQty").textContent = pdQty;

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
if ($("#pdMinus")) $("#pdMinus").addEventListener("click", () => { if (pdQty > 1) pdQty--; $("#pdQty").textContent = pdQty; updatePdTotal(); });
if ($("#pdPlus")) $("#pdPlus").addEventListener("click", () => { pdQty++; $("#pdQty").textContent = pdQty; updatePdTotal(); });

if ($("#pdAddCart")) $("#pdAddCart").addEventListener("click", () => {
  addToCart(activeProduct, pdQty, pdSelectedColor);
  $("#productOverlay").classList.remove("open");
  toast("Added to cart");
});

if ($("#pdBuyNow")) $("#pdBuyNow").addEventListener("click", () => {
  buyNowItem = {
    ...activeProduct,
    name: removeEmojis(activeProduct.name),
    qty: pdQty,
    color: pdSelectedColor,
    deliveryCharge: Number(activeProduct.deliveryCharge || 0)
  };
  $("#productOverlay").classList.remove("open");
  startCheckout("buyNow");
});

// ---------- CART CALCULATIONS & RENDERING ----------
function saveCart() { localStorage.setItem("blume_cart", JSON.stringify(CART)); renderCartBadge(); }

function addToCart(product, qty, color) {
  if (!product) return;
  const key = product.id + "|" + (color || "");
  const existing = CART.find(i => i.key === key);
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
}

function quickAddToCart(id) {
  const p = PRODUCTS.find(x => x.id === id);
  if (p) {
    addToCart(p, 1, (p.colors || [])[0] || null);
    toast("Added to cart");
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

function showStep(n) {
  currentStep = n;
  document.querySelectorAll(".step-dot").forEach(d => {
    const s = Number(d.dataset.step);
    d.classList.toggle("active", s === n);
    d.classList.toggle("done", s < n);
  });
  document.querySelectorAll(".checkout-step").forEach(s => s.classList.toggle("active", Number(s.dataset.step) === n));
  if ($("#backStep")) $("#backStep").style.visibility = n === 1 ? "hidden" : "visible";
  if ($("#nextStep")) $("#nextStep").textContent = n === 5 ? "Confirm Order on WhatsApp" : "Continue";
  if (n === 5) renderFinalSummary();
}

function validateStep(n) {
  if (n === 2) {
    const name = $("#custName").value.trim(), mobile = $("#custMobile").value.trim(), wa = $("#custWhatsapp").value.trim();
    if (!name || !mobile || !wa) { toast("Please fill all required fields"); return false; }
  }
  if (n === 3) {
    const req = ["addrHouse", "addrStreet", "addrArea", "addrCity", "addrDistrict", "addrState", "addrPincode"];
    for (const id of req) if (!$("#" + id).value.trim()) { toast("Please complete the delivery address"); return false; }
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
    <div class="summary-block"><h4>Customer</h4>
      <p>${$("#custName").value}<br>${$("#custMobile").value} ${$("#custEmail").value ? "· " + $("#custEmail").value : ""}</p></div>
    <div class="summary-block"><h4>Delivery Address</h4><p>${addr.replace(/\n/g, "<br>")}</p></div>
    <div class="summary-block"><h4>Order Items</h4>
      ${items.map(i => `<div class="order-line"><span>${removeEmojis(i.name)} ${i.color ? "(" + removeEmojis(i.color) + ")" : ""} × ${i.qty}</span><span>${money(i.price * i.qty)}</span></div>`).join("")}
      <div class="order-line" style="margin-top:8px; border-top:1px dashed #ddd; padding-top:6px;"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      <div class="order-line"><span>Delivery Charge</span><span>${money(delivery)}</span></div>
      <div class="order-line" style="font-weight:700; color:var(--rose-deep); font-size:1.05rem;"><span>Final Total</span><span>${money(total)}</span></div>
    </div>
    ${$("#specialNotes").value.trim() ? `<div class="summary-block"><h4>Special Instructions</h4><p>${removeEmojis($("#specialNotes").value)}</p></div>` : ""}
  `;
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

function buildWhatsappMessage(orderId, items, subtotal, delivery, total) {
  let msg = `==================\n${SETTINGS.businessName.toUpperCase()}\nNEW ORDER\n==================\n\n`;
  msg += `Order ID: ${orderId}\n\nORDER DETAILS:\n\n`;
  items.forEach((i, idx) => {
    msg += `${idx + 1}. ${removeEmojis(i.name)}${i.color ? " (" + removeEmojis(i.color) + ")" : ""}\nQuantity: ${i.qty}\nPrice: ${money(i.price)}\nSubtotal: ${money(i.price * i.qty)}\n\n`;
  });
  msg += `==================\nSubtotal: ${money(subtotal)}\nDelivery Charge: ${money(delivery)}\nFINAL TOTAL: ${money(total)}\n\nCUSTOMER DETAILS:\n\n`;
  msg += `Name: ${$("#custName").value}\nMobile: ${$("#custMobile").value}\nWhatsApp: ${$("#custWhatsapp").value}\n\nDELIVERY ADDRESS:\n\n${fullAddress()}\n\n`;
  msg += `SPECIAL INSTRUCTIONS:\n\n${removeEmojis($("#specialNotes").value).trim() || "None"}\n\n`;
  msg += `==================\nThank you for choosing ${SETTINGS.businessName.toUpperCase()}\n==================`;
  return msg;
}

async function submitOrder() {
  const items = getCheckoutItems();
  const subtotal = getCheckoutSubtotal();
  const deliveryCharge = getCheckoutDeliveryCharge();
  const total = getCheckoutTotal();
  const orderId = await generateOrderId();

  const orderData = {
    orderId,
    customerName: $("#custName").value,
    mobile: $("#custMobile").value,
    whatsapp: $("#custWhatsapp").value,
    email: $("#custEmail").value || "",
    address: {
      house: $("#addrHouse").value, street: $("#addrStreet").value, area: $("#addrArea").value,
      city: $("#addrCity").value, district: $("#addrDistrict").value, state: $("#addrState").value, pincode: $("#addrPincode").value,
    },
    products: items,
    subtotal,
    deliveryCharge,
    total,
    status: "Pending",
    notes: $("#specialNotes").value || "",
    createdAt: serverTimestamp(),
  };

  try {
    await addDoc(collection(db, "orders"), orderData);
  } catch (e) {
    console.warn("Order not saved to Firestore:", e.message);
  }

  const waMessage = buildWhatsappMessage(orderId, items, subtotal, deliveryCharge, total);
  const waUrl = `https://wa.me/${SETTINGS.whatsapp}?text=${encodeURIComponent(waMessage)}`;
  lastOrder = { orderId, waUrl };

  if (checkoutMode === "cart") { CART = []; saveCart(); renderCart(); }
  buyNowItem = null;

  $("#checkoutOverlay").classList.remove("open");
  $("#confirmOrderId").textContent = orderId;
  $("#confirmOverlay").classList.add("open");
  window.open(waUrl, "_blank");
}

if ($("#openWhatsappBtn")) $("#openWhatsappBtn").addEventListener("click", () => { if (lastOrder) window.open(lastOrder.waUrl, "_blank"); });
if ($("#continueShoppingBtn")) $("#continueShoppingBtn").addEventListener("click", () => {
  $("#confirmOverlay").classList.remove("open");
  const shopSection = document.getElementById("shop");
  if (shopSection) shopSection.scrollIntoView({ behavior: "smooth" });
});

// ---------- INIT ----------
renderCartBadge();
renderCart();
loadSettings();
loadCategories();
loadProducts();
