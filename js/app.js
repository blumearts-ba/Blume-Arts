import { db, DEFAULT_SETTINGS } from "./firebase-config.js";
import {
  collection, onSnapshot, addDoc, serverTimestamp, doc, getDoc,
  runTransaction, query, where, getDocs, updateDoc, setDoc, orderBy
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
    const stockNum = Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0));
    const isOut = stockNum <= 0;
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
            <span class="stock-tag ${isOut ? "out" : ""}">${isOut ? "Out of Stock" : "In Stock (" + stockNum + ")"}</span>
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
      const stockNum = Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0));
      if (stockNum <= 0) {
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

  const stockNum = Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0));

  pdQty = stockNum > 0 ? 1 : 0;
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

  if (stockNum <= 0) {
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
      if (stockNum <= 3) {
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
  const stockNum = activeProduct ? Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0)) : 0;
  if (stockNum <= 0) return;
  if (pdQty > 1) pdQty--;
  $("#pdQty").textContent = pdQty;
  updatePdTotal();
});

if ($("#pdPlus")) $("#pdPlus").addEventListener("click", () => {
  const stockNum = activeProduct ? Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0)) : 0;
  if (stockNum <= 0) return;
  if (pdQty >= stockNum) {
    toast(`Only ${stockNum} item(s) available in stock.`);
    return;
  }
  pdQty++;
  $("#pdQty").textContent = pdQty;
  updatePdTotal();
});

if ($("#pdAddCart")) $("#pdAddCart").addEventListener("click", () => {
  if (!activeProduct) return;
  const stockNum = Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0));
  if (stockNum <= 0) {
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
  const stockNum = Number(activeProduct.stockQuantity !== undefined ? activeProduct.stockQuantity : (activeProduct.stock || 0));
  if (stockNum <= 0) {
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
  const stockNum = Number(product.stockQuantity !== undefined ? product.stockQuantity : (product.stock || 0));
  if (stockNum <= 0) {
    toast("Sorry, this item is out of stock.");
    return false;
  }

  const key = product.id + "|" + (color || "");
  const existing = CART.find(i => i.key === key);
  const currentInCart = existing ? existing.qty : 0;

  if (currentInCart + qty > stockNum) {
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
    const stockNum = p ? Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0)) : 9999;
    if (item.qty + delta > stockNum) {
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
  let msg = `==================\n${storeName}\nNEW ORDER\n==================\n\n`;
  msg += `Order ID: ${orderId}\n\nORDER DETAILS:\n\n`;
  items.forEach((i, idx) => {
    msg += `${idx + 1}. ${removeEmojis(i.name)}${i.color ? " (" + removeEmojis(i.color) + ")" : ""}\nQuantity: ${i.qty}\nPrice: ${money(i.price)}\nSubtotal: ${money(i.price * i.qty)}\n\n`;
  });
  msg += `==================\nSubtotal: ${money(subtotal)}\nDelivery Charge: ${money(delivery)}\nFINAL TOTAL: ${money(total)}\n\nCUSTOMER DETAILS:\n\n`;
  msg += `Name: ${removeEmojis($("#custName")?.value || "")}\nMobile: ${$("#custMobile")?.value || ""}\nWhatsApp: ${$("#custWhatsapp")?.value || ""}\nEmail: ${$("#custEmail")?.value || "N/A"}\n\nDELIVERY ADDRESS:\n\n${fullAddress()}\n\n`;
  msg += `SPECIAL INSTRUCTIONS:\n\n${removeEmojis($("#specialNotes")?.value || "").trim() || "None"}\n\n`;
  msg += `==================\nThank you for choosing ${storeName}\n==================`;
  return msg;
}

function resetCheckoutForm() {
  const ids = ["custName", "custMobile", "custWhatsapp", "custEmail", "addrHouse", "addrStreet", "addrArea", "addrCity", "addrDistrict", "addrState", "addrPincode", "specialNotes"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  currentStep = 1;
}

async function submitOrder() {
  const items = getCheckoutItems();
  const subtotal = getCheckoutSubtotal();
  const deliveryCharge = getCheckoutDeliveryCharge();
  const total = getCheckoutTotal();
  const orderId = await generateOrderId();

  const nextBtn = $("#nextStep");
  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.textContent = "Processing Order...";
  }

  try {
    // Atomic Stock Verification & Order Creation Transaction
    await runTransaction(db, async (transaction) => {
      const productUpdates = [];

      // Step 1: Read all products and verify stock atomically
      for (const item of items) {
        if (!item.id) continue;
        const pRef = doc(db, "products", item.id);
        const pSnap = await transaction.get(pRef);
        if (!pSnap.exists()) {
          throw new Error(`Product "${item.name}" is no longer available.`);
        }
        const pData = pSnap.data();
        const currentStock = Number(pData.stockQuantity !== undefined ? pData.stockQuantity : (pData.stock || 0));
        if (currentStock < item.qty) {
          throw new Error(`Insufficient stock for "${item.name}". Only ${currentStock} item(s) left.`);
        }
        productUpdates.push({ ref: pRef, newStock: currentStock - item.qty });
      }

      // Step 2: Decrement stock for all items
      for (const update of productUpdates) {
        transaction.update(update.ref, {
          stockQuantity: update.newStock,
          stock: update.newStock,
          updatedAt: serverTimestamp()
        });
      }

      // Step 3: Create Order Document
      const newOrderRef = doc(collection(db, "orders"));
      const orderData = {
        orderId,
        customerName: $("#custName").value.trim(),
        mobile: $("#custMobile").value.trim(),
        whatsapp: $("#custWhatsapp").value.trim(),
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
        statusHistory: [
          {
            status: "Order Placed",
            timestamp: new Date().toISOString(),
            note: "Order placed by customer"
          }
        ],
        notes: $("#specialNotes").value.trim() || "",
        createdAt: serverTimestamp(),
      };
      transaction.set(newOrderRef, orderData);
    });

    const waMessage = buildWhatsappMessage(orderId, items, subtotal, deliveryCharge, total);
    const cleanPhone = getCleanWhatsappPhone(SETTINGS.whatsapp || SETTINGS.phone);
    const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waMessage)}`;

    lastOrder = {
      orderId,
      items,
      subtotal,
      deliveryCharge,
      total,
      waUrl,
      waMessage,
      phone: cleanPhone
    };

    if (checkoutMode === "cart") { CART = []; saveCart(); renderCart(); }
    buyNowItem = null;

    $("#checkoutOverlay").classList.remove("open");
    $("#confirmOrderId").textContent = orderId;
    $("#confirmOverlay").classList.add("open");
    document.body.style.overflow = "hidden";

  } catch (err) {
    console.error("Order submit transaction error:", err);
    alert(`Order Failed: ${err.message}`);
    toast(`Order Failed: ${err.message}`);
  } finally {
    if (nextBtn) {
      nextBtn.disabled = false;
      nextBtn.textContent = "Continue";
    }
  }
}

// Event Listeners for Order Confirmation Modal Buttons
if ($("#openWhatsappBtn")) {
  $("#openWhatsappBtn").addEventListener("click", () => {
    if (!lastOrder || !lastOrder.waUrl) {
      alert("Order details are missing. Please try placing your order again.");
      toast("Order details missing.");
      return;
    }
    window.open(lastOrder.waUrl, "_blank");
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

  // Review Prompt (Delivered Orders Only)
  const revPrompt = $("#trackReviewPrompt");
  if (revPrompt) {
    revPrompt.style.display = o.status === "Delivered" ? "block" : "none";
  }

  wrap.style.display = "block";
  wrap.scrollIntoView({ behavior: "smooth" });
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
