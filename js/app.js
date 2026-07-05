// === Translit ===
const TRANSLIT_MAP = {
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E',
  'Ж': 'ZH', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L',
  'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S',
  'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'KH', 'Ц': 'TS', 'Ч': 'CH',
  'Ш': 'SH', 'Щ': 'SHCH', 'Ы': 'Y', 'Э': 'E', 'Ю': 'YU', 'Я': 'YA'
};

function transliterate(text) {
  return text.split('').map(ch => TRANSLIT_MAP[ch] || ch).join('');
}

// === BarcodeCache (IndexedDB) ===
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const CACHE_MAX_ENTRIES = 100;

class BarcodeCache {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('barcode-cache', 2);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('barcodes')) {
          db.createObjectStore('barcodes');
        }
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata');
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async get(key) {
    if (!this.db) return undefined;
    const entry = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('barcodes', 'readonly');
      const req = tx.objectStore('barcodes').get(key);
      req.onsuccess = () => resolve(req.result || undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      await this.delete(key);
      return undefined;
    }
    entry.timestamp = Date.now();
    await this.put(key, entry);
    return entry.pngDataUrl;
  }

  async put(key, value) {
    if (!this.db) return;
    const entry = { pngDataUrl: value, timestamp: Date.now() };
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('barcodes', 'readwrite');
      tx.objectStore('barcodes').put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await this.enforceLimit();
  }

  async delete(key) {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('barcodes', 'readwrite');
      tx.objectStore('barcodes').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async enforceLimit() {
    if (!this.db) return;
    const allKeys = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('barcodes', 'readonly');
      const req = tx.objectStore('barcodes').getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (allKeys.length <= CACHE_MAX_ENTRIES) return;
    const entries = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('barcodes', 'readonly');
      const req = tx.objectStore('barcodes').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const sorted = allKeys.map((key, i) => ({ key, timestamp: entries[i].timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = sorted.slice(0, allKeys.length - CACHE_MAX_ENTRIES);
    const tx = this.db.transaction('barcodes', 'readwrite');
    const store = tx.objectStore('barcodes');
    for (const item of toDelete) {
      store.delete(item.key);
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// === BarcodeGenerator ===
class BarcodeGenerator {
  constructor(cache) {
    this.cache = cache;
  }

  async generate(barcode, shelfName) {
    if (typeof JsBarcode === 'undefined') {
      throw new Error('JsBarcode не загружен. Обновите страницу.');
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try {
      JsBarcode(svg, barcode, {
        format: 'CODE128',
        width: 2,
        height: 80,
        displayValue: true,
        text: shelfName,
        fontSize: 16,
        margin: 10
      });
    } catch (e) {
      throw new Error('Ошибка генерации штрих-кода: ' + e.message);
    }

    const svgString = new XMLSerializer().serializeToString(svg);
    const cachedPng = await this.cache.get(barcode);

    const canvas = document.createElement('canvas');
    const img = new Image();
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    return new Promise((resolve, reject) => {
      img.onload = () => {
        canvas.width = img.width * 2;
        canvas.height = img.height * 2;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        const jpgDataUrl = canvas.toDataURL('image/jpeg', 0.95);
        if (cachedPng) {
          resolve({ svg: svgString, pngDataUrl: cachedPng, jpgDataUrl });
        } else {
          const pngDataUrl = canvas.toDataURL('image/png');
          this.cache.put(barcode, pngDataUrl).catch(() => {});
          resolve({ svg: svgString, pngDataUrl, jpgDataUrl });
        }
      };
      img.onerror = () => reject(new Error('Ошибка рендеринга штрих-кода'));
      img.src = url;
    });
  }
}

// === Pagination ===
function vibrate() {
  if (navigator.vibrate) {
    navigator.vibrate(30);
  }
}

function paginate(items, page, perPage) {
  const totalPages = Math.ceil(items.length / perPage);
  const start = (page - 1) * perPage;
  const end = start + perPage;
  return {
    items: items.slice(start, end),
    totalPages: Math.max(totalPages, 1),
    hasPrev: page > 1,
    hasNext: page < totalPages
  };
}

function loadFavorites() {
  try {
    const data = localStorage.getItem('favorites');
    return data ? JSON.parse(data) : [];
  } catch { return []; }
}

function saveFavorites(names) {
  localStorage.setItem('favorites', JSON.stringify(names));
}

function loadPrintQueue() {
  try {
    const data = localStorage.getItem('printQueue');
    return data ? JSON.parse(data) : [];
  } catch { return []; }
}

function savePrintQueue(names) {
  localStorage.setItem('printQueue', JSON.stringify(names));
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// === DataLayer ===
class DataLayer {
  constructor() {
    this.shelves = [];
    this.nameIndex = new Map();
    this.sectionIndex = new Map();
    this.searchItems = [];
    this.products = [];
    this.productByArticle = new Map();
  }

  async load() {
    const resp = await fetch('data/shelves.json');
    if (!resp.ok) {
      throw new Error('Не удалось загрузить данные');
    }
    const data = await resp.json();
    this.shelves = data.shelves;
    this.buildIndexes();
    this.buildSearchIndex();
    return data;
  }

  async loadProducts() {
    const resp = await fetch('data/products.json');
    if (!resp.ok) return;
    const data = await resp.json();
    this.products = data.products || [];
    this.productByArticle.clear();
    for (const p of this.products) {
      this.productByArticle.set(p.article, p);
    }
  }

  buildSearchIndex() {
    this.searchItems = this.shelves.map(s => ({
      shelf: s,
      nameLower: s.name.toLowerCase(),
      barcodeLower: (s.barcode || '').toLowerCase(),
      nameStripped: s.name.toLowerCase().replace(/[.\-\s]/g, ''),
    }));
  }

  buildIndexes() {
    this.nameIndex.clear();
    this.sectionIndex.clear();

    for (const shelf of this.shelves) {
      this.nameIndex.set(shelf.name, shelf);

      if (!this.sectionIndex.has(shelf.section)) {
        this.sectionIndex.set(shelf.section, { racks: [], pallets: [], zones: [] });
      }
      const section = this.sectionIndex.get(shelf.section);
      if (shelf.section === 'СЛУЖЕБНАЯ') {
        section.zones.push(shelf);
      } else if (shelf.type === 'С') {
        section.racks.push(shelf);
      } else if (shelf.type === 'П') {
        section.pallets.push(shelf);
      }
    }
  }

  getSections() {
    const sections = [];
    for (const [name, data] of this.sectionIndex) {
      if (name === 'СЛУЖЕБНАЯ' || name === 'ПИКАП') continue;
      const count = data.racks.length + data.pallets.length;
      if (count > 0) {
        sections.push({ name, label: name, count, hasRacks: data.racks.length > 0, hasPallets: data.pallets.length > 0 });
      }
    }
    return sections.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  getSection(name) {
    return this.sectionIndex.get(name) || { racks: [], pallets: [], zones: [] };
  }

  findShelf(name) {
    return this.nameIndex.get(name) || null;
  }

  findByBarcode(code) {
    if (!code) return null;
    const normalized = code.trim();
    for (const shelf of this.shelves) {
      if (shelf.barcode === normalized) return shelf;
    }
    for (const shelf of this.shelves) {
      if (shelf.name === normalized) return shelf;
    }
    return null;
  }

  getStats() {
    const sections = new Set();
    let totalShelves = 0, totalPallets = 0, totalZones = 0;
    for (const shelf of this.shelves) {
      if (shelf.section !== 'СЛУЖЕБНАЯ' && shelf.section !== 'ПИКАП') {
        sections.add(shelf.section);
      }
      if (shelf.type === 'С') totalShelves++;
      if (shelf.type === 'П') totalPallets++;
      if (shelf.section === 'СЛУЖЕБНАЯ') totalZones++;
    }
    return {
      totalSections: sections.size,
      totalShelves,
      totalPallets,
      totalZones
    };
  }
}

// === Vue App ===
const dataLayer = new DataLayer();
const barcodeCache = new BarcodeCache();
const barcodeGenerator = new BarcodeGenerator(barcodeCache);
const PRODUCT_MERGE_API_URL = 'https://warehouse-barcode-generator-vercel.vercel.app/api/merge-products';

const app = Vue.createApp({
  data() {
    return {
      searchQuery: '',
      searchInput: '',
      activeSection: null,
      currentBarcodeShelf: null,
      barcodeSvg: '',
      barcodePng: null,
      barcodeJpg: null,
      downloadFormat: 'png',
      barcodeError: null,
      barcodeLoading: false,
      printLoading: false,
      printProductLoading: false,
      error: null,
      loading: true,
      stats: { totalSections: 0, totalShelves: 0, totalPallets: 0, totalZones: 0 },
      dataVersion: '',
      dataUpdatedAt: '',
      isDark: false,
      updateAvailable: false,
      swRegistration: null,
      isOffline: !navigator.onLine,
      toastMessage: '',
      toastTimeout: null,
      favorites: [],
      printQueue: [],
      sectionVisibleCount: {},
      enteredSection: null,
      selectedShelfLevels: null,
      barcodeModalOpen: false,
      barcodeMode: 'shelf',
      productSearchOpen: false,
      productSearchArticle: '',
      productUploadOpen: false,
      uploadStep: 'idle', // idle | preview | uploading | done | error
      uploadedNewProducts: [],
      uploadResult: null,
    };
  },

  computed: {
    sectionList() {
      return dataLayer.getSections();
    },

    zones() {
      return dataLayer.getSection('СЛУЖЕБНАЯ').zones;
    },

    pickupPallets() {
      return dataLayer.getSection('ПИКАП').pallets;
    },

    // When in a section: racks (level === null) and pallets
    sectionRacks() {
      if (!this.enteredSection || this.selectedShelfLevels) return [];
      const data = dataLayer.getSection(this.enteredSection);
      return data.racks
        .filter(r => r.level === null)
        .sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));
    },

    sectionPallets() {
      if (!this.enteredSection || this.selectedShelfLevels) return [];
      const data = dataLayer.getSection(this.enteredSection);
      return data.pallets;
    },

    visibleSectionPallets() {
      const all = this.sectionPallets;
      const visible = this.sectionVisibleCount[this.enteredSection + '_pallets'] || 8;
      if (visible >= all.length) return all;
      return all.slice(0, visible);
    },

    sectionPalletHasMore() {
      const visible = this.sectionVisibleCount[this.enteredSection + '_pallets'] || 8;
      return visible < this.sectionPallets.length;
    },

    // Zones for СЛУЖЕБНАЯ section
    sectionZones() {
      if (!this.enteredSection || this.selectedShelfLevels) return [];
      if (this.enteredSection !== 'СЛУЖЕБНАЯ') return [];
      const data = dataLayer.getSection('СЛУЖЕБНАЯ');
      return data.zones;
    },

    // When a rack is selected: its shelves (level !== null)
    shelfLevels() {
      if (!this.selectedShelfLevels) return [];
      const data = dataLayer.getSection(dataLayer.findShelf(this.selectedShelfLevels)?.section || '');
      return data.racks
        .filter(r => r.level !== null && r.name.startsWith(this.selectedShelfLevels))
        .sort((a, b) => parseInt(a.level, 10) - parseInt(b.level, 10));
    },

    selectedShelfData() {
      if (!this.selectedShelfLevels) return null;
      return dataLayer.findShelf(this.selectedShelfLevels);
    },

    favoriteCount() {
      return this.favorites.length;
    },

    favoriteSet() {
      return new Set(this.favorites);
    },

    printQueueSet() {
      return new Set(this.printQueue);
    },

    favoriteShelves() {
      const set = this.favoriteSet;
      if (set.size === 0) return [];
      return dataLayer.shelves.filter(s => set.has(s.name));
    },

    printCount() {
      return this.printQueue.length;
    },

    printShelves() {
      const set = this.printQueueSet;
      if (set.size === 0) return [];
      return dataLayer.shelves.filter(s => set.has(s.name));
    },

    foundProducts() {
      const q = this.productSearchArticle.trim();
      if (!q) return [];
      const articles = q.split(',').map(s => s.trim()).filter(Boolean);
      const results = [];
      for (const article of articles) {
        const product = dataLayer.productByArticle.get(article);
        if (product) results.push(product);
      }
      return results;
    },

    notFoundArticles() {
      const q = this.productSearchArticle.trim();
      if (!q) return [];
      const articles = q.split(',').map(s => s.trim()).filter(Boolean);
      return articles.filter(a => !dataLayer.productByArticle.has(a));
    },

    formattedDataDate() {
      if (!this.dataUpdatedAt) return '';
      try {
        const d = new Date(this.dataUpdatedAt);
        return d.toLocaleDateString('ru-RU', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch {
        return this.dataUpdatedAt;
      }
    },

    searchResults() {
      const q = this.searchQuery.trim().toLowerCase();
      if (q.length < 2) return [];
      const normalizedQ = q.replace(/[.\-\s]/g, '');
      const items = dataLayer.searchItems;
      const results = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.nameLower.includes(q) || item.barcodeLower.includes(q) || item.nameStripped.includes(normalizedQ)) {
          results.push(item.shelf);
          if (results.length >= 50) break;
        }
      }
      return results;
    },
  },

  created() {
    this.debouncedSearch = debounce((val) => {
      this.searchQuery = val;
    }, 250);
  },

  methods: {
    onSearchInput(e) {
      this.searchInput = e.target.value;
      this.debouncedSearch(e.target.value);
    },

    getSectionRacks(sectionName) {
      const data = dataLayer.getSection(sectionName);
      return data.racks
        .filter(r => r.level === null)
        .sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));
    },

    getSectionRacksVisible(sectionName) {
      const all = sectionName === this.enteredSection ? this.sectionRacks : this.getSectionRacks(sectionName);
      const visible = this.sectionVisibleCount[sectionName] || 8;
      if (visible >= all.length) return all;
      return all.slice(0, visible);
    },

    getSectionHasMore(sectionName) {
      const all = sectionName === this.enteredSection ? this.sectionRacks : this.getSectionRacks(sectionName);
      const visible = this.sectionVisibleCount[sectionName] || 8;
      return visible < all.length;
    },

    getSectionTotalCount(sectionName) {
      return this.getSectionRacks(sectionName).length;
    },

    showSection(name) {
      vibrate();
      this.activeSection = name === this.activeSection ? null : name;
    },

    selectSection(name) {
      vibrate();
      this.activeSection = name;
    },

    enterSection(name) {
      vibrate();
      this.enteredSection = name;
      this.activeSection = null;
      this.selectedShelfLevels = null;
      localStorage.setItem('lastSection', name);
    },

    backFromSection() {
      vibrate();
      if (this.selectedShelfLevels) {
        this.selectedShelfLevels = null;
      } else {
        this.enteredSection = null;
      }
    },

    selectShelfForLevels(shelfName) {
      vibrate();
      this.selectedShelfLevels = shelfName;
    },

    loadMore(sectionName, type) {
      vibrate();
      if (type === 'pallets') {
        const key = sectionName + '_pallets';
        const current = this.sectionVisibleCount[key] || 8;
        const total = this.sectionPallets.length;
        const step = Math.min(12, total - current);
        if (step > 0) {
          this.sectionVisibleCount[key] = current + step;
        }
        return;
      }
      const current = this.sectionVisibleCount[sectionName] || 8;
      const allRacks = this.getSectionRacks(sectionName);
      const total = allRacks.length;
      const step = Math.min(12, total - current);
      this.sectionVisibleCount[sectionName] = current + step;
    },

    async generateBarcode(item) {
      try {
        let barcode = item.barcode;
        let text = item.name;
        if (this.barcodeMode === 'product') {
          text = item.name + ' | ' + item.article;
        }
        if (!barcode) {
          barcode = transliterate(text);
        }
        const result = await barcodeGenerator.generate(barcode, text);
        this.barcodeSvg = result.svg;
        this.barcodePng = result.pngDataUrl;
        this.barcodeJpg = result.jpgDataUrl;
      } catch (e) {
        this.barcodeError = e.message || 'Ошибка генерации штрих-кода';
      }
    },

    async selectShelf(shelf) {
      vibrate();
      this.barcodeMode = 'shelf';
      this.currentBarcodeShelf = shelf;
      this.barcodeError = null;
      this.barcodeSvg = '';
      this.barcodePng = null;
      this.barcodeJpg = null;
      this.barcodeLoading = true;
      this.barcodeModalOpen = true;
      try {
        await this.generateBarcode(shelf);
      } finally {
        this.barcodeLoading = false;
      }
    },

    openProductSearch() {
      vibrate();
      this.productSearchOpen = true;
      this.productSearchArticle = '';
      this.enteredSection = null;
      this.selectedShelfLevels = null;
      this.activeSection = null;
    },

    closeProductSearch() {
      this.productSearchOpen = false;
      this.productSearchArticle = '';
    },

    async selectProduct(product) {
      vibrate();
      this.barcodeMode = 'product';
      this.currentBarcodeShelf = product;
      this.barcodeError = null;
      this.barcodeSvg = '';
      this.barcodePng = null;
      this.barcodeJpg = null;
      this.barcodeLoading = true;
      this.barcodeModalOpen = true;
      try {
        await this.generateBarcode(product);
      } finally {
        this.barcodeLoading = false;
      }
    },

    closeBarcodeModal() {
      this.barcodeModalOpen = false;
      this.barcodeMode = 'shelf';
    },

    downloadBarcode() {
      const dataUrl = this.downloadFormat === 'jpg' ? this.barcodeJpg : this.barcodePng;
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = this.currentBarcodeShelf.name + '.' + this.downloadFormat;
      link.href = dataUrl;
      link.click();
    },

    async copyBarcode() {
      if (!this.currentBarcodeShelf || !this.currentBarcodeShelf.barcode) return;
      try {
        await navigator.clipboard.writeText(this.currentBarcodeShelf.barcode);
        this.showToast('Код скопирован');
      } catch {
        this.showToast('Не удалось скопировать');
      }
    },

    async printAll() {
      vibrate();
      const shelves = this.printShelves;
      if (shelves.length === 0) return;
      this.printLoading = true;
      this.showToast('Генерация штрихов для печати...');
      await this.renderPrintPages(shelves);
      this.printLoading = false;
    },

    async printProductFound() {
      vibrate();
      const products = this.foundProducts;
      if (products.length === 0) return;
      this.printProductLoading = true;
      this.showToast('Генерация штрихов для печати...');
      await this.renderPrintPages(products, p => p.name + ' | ' + p.article);
      this.printProductLoading = false;
    },

    async printOne(item) {
      vibrate();
      const getText = this.barcodeMode === 'product'
        ? p => p.name + ' | ' + p.article
        : null;
      await this.renderPrintPages([item], getText);
    },

    async renderPrintPages(items, getText) {
      const printArea = document.getElementById('print-area');
      if (!printArea) return;
      printArea.innerHTML = '';
      let html = '<div class="print-page">';
      let idx = 0;
      const perPage = 12;
      for (const item of items) {
        try {
          const text = getText ? getText(item) : item.name;
          let barcode = item.barcode || transliterate(text);
          const result = await barcodeGenerator.generate(barcode, text);
          html += '<div class="print-label">' + result.svg + '</div>';
          idx++;
          if (idx % perPage === 0 && idx < items.length) {
            html += '</div><div class="print-page">';
          }
        } catch (e) {
          // skip individual errors
        }
      }
      html += '</div>';
      printArea.innerHTML = html;
      await new Promise(r => setTimeout(r, 200));
      window.print();
      printArea.innerHTML = '';
    },

    showToast(message) {
      this.toastMessage = message;
      if (this.toastTimeout) clearTimeout(this.toastTimeout);
      this.toastTimeout = setTimeout(() => { this.toastMessage = ''; }, 2000);
    },

    async retryLoad() {
      this.error = null;
      this.loading = true;
      await this.init();
    },

    async init() {
      try {
        await barcodeCache.init();
        const [shelfData] = await Promise.all([
          dataLayer.load(),
          dataLayer.loadProducts()
        ]);
        this.stats = dataLayer.getStats();
        this.dataVersion = shelfData.version || '';
        this.dataUpdatedAt = shelfData.updatedAt || '';
        this.favorites = loadFavorites();
        this.printQueue = loadPrintQueue();
        this.loading = false;
      } catch (e) {
        this.loading = false;
        this.error = 'Не удалось загрузить данные. Проверьте подключение и обновите страницу.';
      }
    },

    updateApp() {
      if (this.swRegistration && this.swRegistration.waiting) {
        this.swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    },

    isFavorite(name) {
      return this.favoriteSet.has(name);
    },

    toggleFavorite(name) {
      const idx = this.favorites.indexOf(name);
      if (idx === -1) {
        this.favorites.push(name);
      } else {
        this.favorites.splice(idx, 1);
      }
      saveFavorites(this.favorites);
    },

    isInPrintQueue(name) {
      return this.printQueueSet.has(name);
    },

    togglePrintQueue(name) {
      const idx = this.printQueue.indexOf(name);
      if (idx === -1) {
        this.printQueue.push(name);
      } else {
        this.printQueue.splice(idx, 1);
      }
      savePrintQueue(this.printQueue);
    },

    selectPrint() {
      vibrate();
      this.activeSection = 'PRINT';
      this.enteredSection = null;
      this.selectedShelfLevels = null;
    },

    selectFavorite() {
      vibrate();
      this.activeSection = 'FAVORITES';
      this.enteredSection = null;
      this.selectedShelfLevels = null;
    },

    backFromView() {
      vibrate();
      if (this.activeSection === 'FAVORITES' || this.activeSection === 'PRINT') {
        this.activeSection = null;
      } else {
        this.backFromSection();
      }
    },

    clearFavorites() {
      this.favorites = [];
      saveFavorites(this.favorites);
    },

    clearPrintQueue() {
      this.printQueue = [];
      savePrintQueue(this.printQueue);
    },

    removeFromPrintQueue(name) {
      const idx = this.printQueue.indexOf(name);
      if (idx !== -1) {
        this.printQueue.splice(idx, 1);
        savePrintQueue(this.printQueue);
      }
    },

    removeFromFavorites(name) {
      const idx = this.favorites.indexOf(name);
      if (idx !== -1) {
        this.favorites.splice(idx, 1);
        saveFavorites(this.favorites);
      }
    },

    toggleTheme() {
      this.isDark = !this.isDark;
      document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
      localStorage.setItem('theme', this.isDark ? 'dark' : 'light');
      document.querySelector('meta[name="theme-color"]').content = this.isDark ? '#121212' : '#d48a1c';
    },

    initTheme() {
      const saved = localStorage.getItem('theme');
      this.isDark = saved ? saved === 'dark' : true;
      document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
      document.querySelector('meta[name="theme-color"]').content = this.isDark ? '#121212' : '#d48a1c';
    },

    openProductUpload() {
      this.productUploadOpen = true;
      this.uploadStep = 'idle';
      this.uploadedNewProducts = [];
      this.uploadResult = null;
    },
    closeProductUpload() {
      this.productUploadOpen = false;
      this.uploadStep = 'idle';
      this.uploadedNewProducts = [];
      this.uploadResult = null;
    },
    handleProductCSV(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        const lines = text.split('\n').filter(line => line.trim());
        const newProducts = [];
        const duplicates = [];
        const seenArticles = new Set();

        // Skip header, find relevant columns
        const header = lines[0].split(';').map(h => h.trim());
        const artIdx = header.indexOf('Код товара');
        const nameIdx = header.indexOf('Наименование');
        const barcodeIdx = header.indexOf('ШК товара');

        if (artIdx === -1 || nameIdx === -1 || barcodeIdx === -1) {
          this.uploadResult = { error: 'Не найдены колонки: Код товара, Наименование, ШК товара' };
          this.uploadStep = 'error';
          return;
        }

        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(';').map(c => c.trim());
          const article = cols[artIdx];
          const name = cols[nameIdx];
          const barcode = cols[barcodeIdx];
          if (!article || !barcode) continue;

          if (dataLayer.productByArticle.has(article)) { continue; }
          if (seenArticles.has(article)) continue;
          seenArticles.add(article);

          newProducts.push({ article, name, barcode });
        }

        this.uploadedNewProducts = newProducts;
        this.uploadStep = 'preview';
      };
      reader.onerror = () => {
        this.uploadResult = { error: 'Ошибка чтения файла' };
        this.uploadStep = 'error';
      };
      reader.readAsText(file);
    },
    async confirmProductUpload() {
      this.uploadStep = 'uploading';
      try {
        const res = await fetch(PRODUCT_MERGE_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ products: this.uploadedNewProducts })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Server error');
        this.uploadResult = data;
        this.uploadStep = 'done';
      } catch (err) {
        this.uploadResult = { error: err.message };
        this.uploadStep = 'error';
      }
    },

  },

  async mounted() {
    const errDiv = document.getElementById('vue-load-error');
    if (errDiv) errDiv.style.display = 'none';
    this.initTheme();
    await this.init();

    // Restore last section unless navigating to favorites/print
    const hash = window.location.hash;
    if (!hash || hash === '#') {
      const lastSection = localStorage.getItem('lastSection');
      if (lastSection && dataLayer.getSection(lastSection)) {
        this.enteredSection = lastSection;
      }
    }

    window.addEventListener('online', () => { this.isOffline = false; });
    window.addEventListener('offline', () => { this.isOffline = true; });

    // Close modals on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.barcodeModalOpen) {
          this.closeBarcodeModal();
        } else if (this.productSearchOpen) {
          this.closeProductSearch();
        }
      }
    });

    // Handle hash navigation for favorites/print
    const handleHash = () => {
      if (window.location.hash === '#print') {
        this.selectPrint();
      } else if (window.location.hash === '#favorites') {
        this.selectFavorite();
      }
    };
    window.addEventListener('hashchange', handleHash);
  }
});

// Pagination component
app.component('nav-pagination', {
  props: ['page', 'total'],
  emits: ['change'],
  template: `
    <nav class="mt-3">
      <ul class="pagination justify-content-center">
        <li class="page-item" :class="{ disabled: page <= 1 }">
          <button class="page-link" @click="$emit('change', page - 1)" :disabled="page <= 1">Назад</button>
        </li>
        <li v-for="p in visiblePages" :key="p" class="page-item" :class="{ active: p === page }">
          <button class="page-link" @click="$emit('change', p)">{{ p }}</button>
        </li>
        <li class="page-item" :class="{ disabled: page >= total }">
          <button class="page-link" @click="$emit('change', page + 1)" :disabled="page >= total">Вперёд</button>
        </li>
      </ul>
    </nav>
  `,
  computed: {
    visiblePages() {
      const pages = [];
      const start = Math.max(1, this.page - 2);
      const end = Math.min(this.total, this.page + 2);
      for (let i = start; i <= end; i++) pages.push(i);
      return pages;
    }
  }
});

app.mount('#app');

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          app.updateAvailable = true;
          app.swRegistration = reg;
        }
      });
    });
  }).catch(() => {});

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}
