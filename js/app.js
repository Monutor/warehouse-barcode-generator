// === Translit ===
const TRANSLIT_MAP = {
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'YO',
  'Ж': 'ZH', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L',
  'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S',
  'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'KH', 'Ц': 'TS', 'Ч': 'CH',
  'Ш': 'SH', 'Щ': 'SHCH', 'Ы': 'Y', 'Э': 'E', 'Ю': 'YU', 'Я': 'YA',
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l',
  'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's',
  'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch',
  'ш': 'sh', 'щ': 'shch', 'ы': 'y', 'э': 'e', 'ю': 'yu', 'я': 'ya'
};

function transliterate(text) {
  return text.split('').map(ch => TRANSLIT_MAP[ch] || ch).join('');
}

// P1-5: имена товаров содержат / : " | и т.п. — чистим для имени файла
function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// === BarcodeCache (IndexedDB) ===
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const CACHE_MAX_ENTRIES = 100;

// Печать: 12 этикеток на странице A4, максимум 10 страниц за раз —
// большие очереди вешают вкладку (синхронный рендер сотен SVG).
const PRINT_LABELS_PER_PAGE = 12;
const PRINT_MAX_LABELS = 120;

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
    // Пишем обновлённую запись напрямую, минуя put():
    // put(key, value) ожидает строку PNG, а не объект.
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('barcodes', 'readwrite');
      tx.objectStore('barcodes').put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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
    // P1-2: ключ кэша включает отображаемый текст — один ШК может
    // соответствовать разным названиям (дубли ШК в products.json)
    const cacheKey = JSON.stringify([barcode, shelfName]);
    const cachedPng = await this.cache.get(cacheKey);

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
          this.cache.put(cacheKey, pngDataUrl).catch(() => {});
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
    this.barcodeIndex = new Map();
    this.sectionIndex = new Map();
    this.searchItems = [];
    this.products = [];
    this.productByArticle = new Map();
    this.productByBarcode = new Map();
    this.productNameIndex = [];
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

  _parseProducts(raw) {
    const items = Array.isArray(raw) ? raw : (raw && raw.products) || [];
    const products = [];
    for (const item of items) {
      // Два формата: локальный data/products.json (article/name/barcode)
      // и удалённый db.json (русские ключи «Код товара» и т.д.)
      const article = String(item['article'] ?? item['Код товара'] ?? '').trim();
      const name = String(item['name'] ?? item['Наименование'] ?? '').trim();
      const barcode = String(item['barcode'] ?? item['ШК товара'] ?? '').trim();
      if (!article || !name || !barcode) continue;
      products.push({ article, name, barcode });
    }
    return products;
  }

  async loadProducts() {
    let products = [];
    let commitDate = null;
    // P1-3: берём реальную версию из данных, а не Date.now()
    let version = null;

    try {
      const resp = await fetch('https://raw.githubusercontent.com/Monutor/DataBaseProducts/main/db.json');
      if (resp.ok) {
        const remote = await resp.json();
        products = this._parseProducts(remote);
        if (remote && remote.version != null) version = remote.version;
        commitDate = await this._getCachedCommitDate();
      }
    } catch {}

    if (!products.length) {
      try {
        const localResp = await fetch('data/products.json');
        if (localResp.ok) {
          const local = await localResp.json();
          products = this._parseProducts(local);
          if (version == null && local && local.version != null) version = local.version;
          if (!commitDate && local.updatedAt) commitDate = new Date(local.updatedAt);
        }
      } catch {}
    }

    this.products = products;
    this.productByArticle.clear();
    this.productByBarcode.clear();
    this.productNameIndex = [];
    for (const p of this.products) {
      this.productByArticle.set(p.article, p);
      // ШК почти уникален (1 дубль на 15К) — первым выигрывает
      if (p.barcode && !this.productByBarcode.has(p.barcode.trim())) {
        this.productByBarcode.set(p.barcode.trim(), p);
      }
      this.productNameIndex.push({ p, nameLower: (p.name || '').toLowerCase() });
    }

    return {
      version: version != null ? version : (commitDate ? commitDate.getTime() : Date.now()),
      updatedAt: commitDate ? commitDate.toISOString() : null
    };
  }

  async _getCachedCommitDate() {
    const now = Date.now();
    const cached = localStorage.getItem('githubCommitDate');
    if (cached && now - new Date(cached).getTime() < 24 * 60 * 60 * 1000) {
      return new Date(cached);
    }
    try {
      const commitsResp = await fetch('https://api.github.com/repos/Monutor/DataBaseProducts/commits?per_page=1');
      if (commitsResp.ok) {
        const commits = await commitsResp.json();
        if (commits[0] && commits[0].commit.author.date) {
          const d = new Date(commits[0].commit.author.date);
          localStorage.setItem('githubCommitDate', d.toISOString());
          return d;
        }
      }
    } catch {}
    return null;
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
    this.barcodeIndex.clear();
    this.sectionIndex.clear();

    for (const shelf of this.shelves) {
      // Имена не уникальны (есть дубли с разными ШК) — первым выигрывает.
      // Канонический идентификатор полки — barcode (уникален).
      if (!this.nameIndex.has(shelf.name)) {
        this.nameIndex.set(shelf.name, shelf);
      }
      if (!this.barcodeIndex.has(shelf.barcode)) {
        this.barcodeIndex.set(shelf.barcode, shelf);
      }

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
    if (normalized && this.barcodeIndex.has(normalized)) return this.barcodeIndex.get(normalized);
    if (this.nameIndex.has(normalized)) return this.nameIndex.get(normalized);
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
      totalZones,
      totalProducts: this.products.length
    };
  }
}

const PRODUCT_SEARCH_LIMIT = 50;

// Поиск товаров: точное совпадение (артикул/ШК) — сразу.
// Числовые запросы ищутся только по числам (суффикс ШК, подстрока
// артикула) и никогда — по именам: иначе «40» находит 50 строк вида
// «J40», «WS-40», «400 DUAL». Текстовые — по подстроке в названии.
function findProducts(query, limit = PRODUCT_SEARCH_LIMIT) {
  if (typeof query !== 'string') return [];
  const q = query.trim();
  if (q.length < 2) return [];
  const byArticle = dataLayer?.productByArticle?.get(q);
  if (byArticle) return [byArticle];
  const byBarcode = dataLayer?.productByBarcode?.get(q);
  if (byBarcode) return [byBarcode];
  const results = [];
  const seen = new Set();
  const push = (prod) => {
    if (prod && !seen.has(prod.article)) {
      seen.add(prod.article);
      results.push(prod);
    }
  };
  if (/^\d+$/.test(q)) {
    if (q.length >= 4) {
      for (const prod of (dataLayer?.products || [])) {
        if (results.length >= limit) break;
        if (prod.barcode && prod.barcode.trim().endsWith(q)) push(prod);
      }
    }
    if (q.length >= 3) {
      for (const prod of (dataLayer?.products || [])) {
        if (results.length >= limit) break;
        if (prod.article && prod.article.includes(q)) push(prod);
      }
    }
    return results;
  }
  const lower = q.toLowerCase();
  for (const entry of (dataLayer?.productNameIndex || [])) {
    if (results.length >= limit) break;
    if (entry.nameLower.includes(lower)) push(entry.p);
  }
  return results;
}

function findProduct(query) {
  const list = findProducts(query, 1);
  return list.length > 0 ? list[0] : null;
}

// === Vue App ===
const dataLayer = new DataLayer();
const barcodeCache = new BarcodeCache();
const barcodeGenerator = new BarcodeGenerator(barcodeCache);

const app = Vue.createApp({
  data() {
    return {
      searchQuery: '',
      searchInput: '',
      instructionsOpen: false,
      statsOpen: false,
      activeSection: null,
      currentBarcodeShelf: null,
      barcodeSvg: '',
      barcodePng: null,
      barcodeJpg: null,
      // P1-5: фактически закодированное значение (может быть транслитом)
      barcodeValue: '',
      downloadFormat: 'png',
      barcodeError: null,
      barcodeLoading: false,
      printLoading: false,
      printProductLoading: false,
      error: null,
      loading: true,
      stats: { totalSections: 0, totalShelves: 0, totalPallets: 0, totalZones: 0, totalProducts: 0 },
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
      productSearchQuery: '',
      productPanelOpen: false,
      productPanelBarcodeSvg: '',
      productPanelBarcodePng: null,
      productPanelBarcodeJpg: null,
      // P1-5: выбранный в панели товар и его фактический ШК (для скачивания)
      productPanelProduct: null,
      productPanelBarcodeValue: '',
       productPanelBarcodeLoading: false,
       productPanelBarcodeError: null,
        qrScannerOpen: false,
        _cam2qrScanner: null,
        qrScannerState: 'idle', // idle | camera-select | scanning | result | error
        qrScanResult: null,
        qrScanError: null,
        qrVideoReady: false,
        qrSelectedCameraId: null,
        qrShowCameraList: false,
        qrAllCameras: [],
        qrTorchOn: false,
        qrZoomLevel: 1.0,
        // P1-4: реальный диапазон зума камеры (из getCapabilities)
        qrZoomMin: 1,
        qrZoomMax: 3,
        qrZoomStep: 0.1,
        _qrVideoTrack: null,
        qrZoomSupported: false,
      mvideoViewOpen: false,
      mvideoArticle: '',
      shelvesViewOpen: false,

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
      return dataLayer.shelves.filter(s => set.has(s.barcode));
    },

    printCount() {
      return this.printQueue.length;
    },

    printShelves() {
      const set = this.printQueueSet;
      if (set.size === 0) return [];
      return dataLayer.shelves.filter(s => set.has(s.barcode));
    },

    foundProducts() {
      const q = this.productSearchQuery.trim();
      if (!q) return [];
      const queries = q.split(',').map(s => s.trim()).filter(Boolean);
      const results = [];
      const seenQueries = new Set();
      const seenArticles = new Set();
      for (const query of queries) {
        if (seenQueries.has(query)) continue;
        seenQueries.add(query);
        for (const product of findProducts(query, PRODUCT_SEARCH_LIMIT)) {
          if (seenArticles.has(product.article)) continue;
          seenArticles.add(product.article);
          results.push(product);
        }
      }
      return results;
    },

    notFoundArticles() {
      const q = this.productSearchQuery.trim();
      if (!q) return [];
      const queries = q.split(',').map(s => s.trim()).filter(Boolean);
      return queries.filter(a => !findProduct(a));
    },

    formattedDataDate() {
      if (!this.dataUpdatedAt && !this.dataVersion) return '';
      try {
        let result = '';
        if (this.dataUpdatedAt) {
          const d = new Date(this.dataUpdatedAt);
          result = d.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
        }
        if (this.dataVersion) {
          result += ` (версия: ${this.dataVersion})`;
        }
        return result;
      } catch {
        return this.dataUpdatedAt || '';
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

  watch: {
    // Поиск по 15К товаров на каждое нажатие вешает UI —
    // тяжёлые computed работают с дебаунснутым значением (250мс)
    productSearchArticle(val) {
      this.debouncedProductSearch(val);
    },
    // Пока открыта любая модалка — страница под ней не скроллится
    barcodeModalOpen() {
      this._lockBodyScroll();
    },
    qrScannerOpen() {
      this._lockBodyScroll();
    },
  },

  created() {
    this.debouncedSearch = debounce((val) => {
      this.searchQuery = val;
    }, 250);
    this.debouncedProductSearch = debounce((val) => {
      this.productSearchQuery = val;
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
        this.barcodeValue = barcode;
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
      this.barcodeValue = '';
      this.barcodeLoading = true;
      this.barcodeModalOpen = true;
      this.productPanelOpen = false;
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
      this.productSearchQuery = '';
      this.enteredSection = null;
      this.selectedShelfLevels = null;
      this.activeSection = null;
    },

    closeProductSearch() {
      this.productSearchOpen = false;
      this.productSearchArticle = '';
      this.productSearchQuery = '';
    },

    openProductPanel() {
      vibrate();
      this.productPanelOpen = true;
      this.productSearchArticle = '';
      this.productSearchQuery = '';
      this.productPanelBarcodeSvg = '';
      this.productPanelBarcodePng = null;
      this.productPanelBarcodeJpg = null;
      this.productPanelProduct = null;
      this.productPanelBarcodeValue = '';
      this.productPanelBarcodeError = null;
    },

    closeProductPanel() {
      this.productPanelOpen = false;
      this.productSearchArticle = '';
      this.productSearchQuery = '';
    },

    async selectProductInPanel(product) {
      vibrate();
      this.productPanelBarcodeError = null;
      this.productPanelBarcodeSvg = '';
      this.productPanelBarcodePng = null;
      this.productPanelBarcodeJpg = null;
      this.productPanelProduct = product;
      this.productPanelBarcodeValue = '';
      this.productPanelBarcodeLoading = true;
      try {
        const barcode = product.barcode || transliterate(product.name);
        const text = product.name + ' | ' + product.article;
        const result = await barcodeGenerator.generate(barcode, text);
        this.productPanelBarcodeValue = barcode;
        this.productPanelBarcodeSvg = result.svg;
        this.productPanelBarcodePng = result.pngDataUrl;
        this.productPanelBarcodeJpg = result.jpgDataUrl;
      } catch (e) {
        this.productPanelBarcodeError = e.message || 'Ошибка генерации штрих-кода';
      } finally {
        this.productPanelBarcodeLoading = false;
      }
    },

    async selectProduct(product) {
      vibrate();
      this.barcodeMode = 'product';
      this.currentBarcodeShelf = product;
      this.barcodeError = null;
      this.barcodeSvg = '';
      this.barcodePng = null;
      this.barcodeJpg = null;
      this.barcodeValue = '';
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
      this.productPanelOpen = false;
      this.productSearchArticle = '';
      this.productSearchQuery = '';
    },

    _lockBodyScroll() {
      const locked = this.barcodeModalOpen || this.qrScannerOpen;
      document.body.classList.toggle('modal-open', locked);
    },

    rescanQr() {
      this.closeBarcodeModal();
      this.$nextTick(() => {
        this.openQrScanner();
      });
    },

    downloadBarcode() {
      // P1-5: при открытой панели скачиваем ШК панели, а не полки;
      // имя файла чистим от запрещённых символов
      const usePanel = this.productPanelOpen && (this.productPanelBarcodePng || this.productPanelBarcodeJpg);
      const dataUrl = this.downloadFormat === 'jpg'
        ? (usePanel ? this.productPanelBarcodeJpg : this.barcodeJpg)
        : (usePanel ? this.productPanelBarcodePng : this.barcodePng);
      if (!dataUrl) return;
      const src = usePanel ? this.productPanelProduct : this.currentBarcodeShelf;
      const fallback = usePanel ? this.productPanelBarcodeValue : this.barcodeValue;
      const base = sanitizeFilename(src && src.name) || String(fallback || 'barcode');
      const link = document.createElement('a');
      link.download = base + '.' + this.downloadFormat;
      link.href = dataUrl;
      link.click();
    },

    async copyBarcode() {
      // P1-5: копируем фактически закодированное значение (учитывает транслит
      // и ШК открытой панели), а не поле item.barcode
      let text = this.barcodeValue;
      if (this.productPanelOpen && this.productPanelBarcodeValue) {
        text = this.productPanelBarcodeValue;
      }
      if (!text && this.currentBarcodeShelf) text = this.currentBarcodeShelf.barcode;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(String(text));
      } catch {
        if (!this._legacyCopy(String(text))) {
          this.showToast('Не удалось скопировать');
          return;
        }
      }
      this.showToast('Код скопирован');
    },

    _legacyCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    },

    async copyProductBarcode(product) {
      if (!product) return;
      // P1-5: тот же фолбэк, что при генерации, — копируем реальное значение
      const text = String(product.barcode || transliterate(product.name) || '');
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        this.showToast('ШК скопирован');
      } catch {
        if (!this._legacyCopy(text)) {
          this.showToast('Не удалось скопировать');
        } else {
          this.showToast('ШК скопирован');
        }
      }
    },

    async copyProductArticle(product) {
      if (!product || !product.article) return;
      const text = String(product.article);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (!this._legacyCopy(text)) {
          this.showToast('Не удалось скопировать');
          return;
        }
      }
      this.showToast('Артикул скопирован');
    },

    copyCurrentArticle() {
      // Кнопка в футере модалки товара: currentBarcodeShelf там — сам продукт
      if (this.barcodeMode !== 'product') return Promise.resolve();
      return this.copyProductArticle(this.currentBarcodeShelf);
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
      if (!printArea || items.length === 0) return;
      let list = items;
      if (items.length > PRINT_MAX_LABELS) {
        this.showToast('Много этикеток: печатаем первые ' + PRINT_MAX_LABELS + ' из ' + items.length);
        list = items.slice(0, PRINT_MAX_LABELS);
      }
      printArea.innerHTML = '';
      let html = '<div class="print-page">';
      let idx = 0;
      for (const item of list) {
        try {
          const text = getText ? getText(item) : item.name;
          const barcode = item.barcode || transliterate(text);
          const result = await barcodeGenerator.generate(barcode, text);
          html += '<div class="print-label">' + result.svg + '</div>';
          idx++;
          if (idx % PRINT_LABELS_PER_PAGE === 0 && idx < list.length) {
            html += '</div><div class="print-page">';
            this.showToast('Генерация штрихов: ' + idx + ' / ' + list.length);
            // Даём UI обновить тост прогресса между страницами
            await new Promise(r => setTimeout(r, 0));
          }
        } catch (e) {
          // skip individual errors
        }
      }
      html += '</div>';
      if (idx === 0) {
        this.showToast('Не удалось сгенерировать ни одного штрих-кода');
        return;
      }
      printArea.innerHTML = html;
      await new Promise(r => setTimeout(r, 200));
      window.print();
      // НЕ чистим здесь: window.print() асинхронен в мобильных браузерах,
      // синхронная очистка даёт пустые страницы. Очистка — по afterprint (см. mounted).
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
        const [shelfData, productData] = await Promise.all([
          dataLayer.load(),
          dataLayer.loadProducts()
        ]);
        this.stats = dataLayer.getStats();
        this.dataVersion = productData?.version || shelfData.version || '';
        this.dataUpdatedAt = productData?.updatedAt || shelfData.updatedAt || '';
        this.favorites = this.migrateShelfKeys(loadFavorites());
        this.printQueue = this.migrateShelfKeys(loadPrintQueue());
        saveFavorites(this.favorites);
        savePrintQueue(this.printQueue);
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

    // Избранное/очередь хранятся по barcode (уникален).
    // Старые записи по имени мигрируют в barcode, неизвестные отбрасываются.
    migrateShelfKeys(keys) {
      const out = [];
      const seen = new Set();
      for (const key of keys) {
        let barcode = null;
        if (dataLayer.barcodeIndex.has(key)) {
          barcode = key;
        } else {
          const shelf = dataLayer.findShelf(key);
          if (shelf) barcode = shelf.barcode;
        }
        if (barcode && !seen.has(barcode)) {
          seen.add(barcode);
          out.push(barcode);
        }
      }
      return out;
    },

    isFavorite(barcode) {
      return this.favoriteSet.has(barcode);
    },

    toggleInstructions() {
      this.instructionsOpen = !this.instructionsOpen;
    },

    toggleStats() {
      this.statsOpen = !this.statsOpen;
    },

    toggleFavorite(barcode) {
      const idx = this.favorites.indexOf(barcode);
      if (idx === -1) {
        this.favorites.push(barcode);
      } else {
        this.favorites.splice(idx, 1);
      }
      saveFavorites(this.favorites);
    },

    isInPrintQueue(barcode) {
      return this.printQueueSet.has(barcode);
    },

    togglePrintQueue(barcode) {
      const idx = this.printQueue.indexOf(barcode);
      if (idx === -1) {
        this.printQueue.push(barcode);
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

    removeFromPrintQueue(barcode) {
      const idx = this.printQueue.indexOf(barcode);
      if (idx !== -1) {
        this.printQueue.splice(idx, 1);
        savePrintQueue(this.printQueue);
      }
    },

    removeFromFavorites(barcode) {
      const idx = this.favorites.indexOf(barcode);
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

    async _stopScanning() {
      // P1-4: останавливаем треки, иначе камера (и фонарик) остаются включены
      if (this._cam2qrScanner) {
        try { this._cam2qrScanner.destroy(); } catch {}
        this._cam2qrScanner = null;
      }
      const video = document.getElementById('qr-video');
      if (video && video.srcObject) {
        for (const track of video.srcObject.getTracks()) {
          try { track.stop(); } catch {}
        }
        video.srcObject = null;
      }
      this._qrVideoTrack = null;
    },

    openQrScanner() {
       vibrate();
       this.qrScannerOpen = true;
       this.qrScannerState = 'scanning';
       this.qrScanError = null;
       this.qrVideoReady = false;
       this.qrSelectedCameraId = localStorage.getItem('qrLastCameraId');
       this.qrShowCameraList = false;
       this.qrTorchOn = false;
       this.qrAllCameras = [];
       this.qrZoomLevel = 1.0;
       this.qrZoomSupported = false;
       this.qrZoomMin = 1;
       this.qrZoomMax = 3;
       this.qrZoomStep = 0.1;
       this.$nextTick(() => { this._initScanner(); });
    },

    selectQrCamera(deviceId) {
      this.switchQrCamera(deviceId);
    },

    async toggleQrCameraList() {
      if (this.qrShowCameraList) {
        this.qrShowCameraList = false;
        return;
      }
      try {
        const cam2qr = window.__cam2qr || await import('https://cdn.jsdelivr.net/npm/cam2qr@1.1.1/dist/index.js');
        const cameras = await cam2qr.listCameras();
        this.qrAllCameras = cameras.map(cam => ({
          id: cam.id,
          label: cam.label,
          facing: cam.facing,
        }));
        this.qrShowCameraList = true;
      } catch (e) {
        this.qrAllCameras = [];
      }
    },

    async switchQrCamera(deviceId) {
      if (this._cam2qrScanner) {
        try {
          await this._cam2qrScanner.setCamera({ deviceId });
          this.qrSelectedCameraId = deviceId;
          localStorage.setItem('qrLastCameraId', deviceId);
          this.qrVideoReady = true;
          this.qrShowCameraList = false;
          this.qrTorchOn = false;
          return;
        } catch (e) {
          this._stopScanning();
        }
      }
      this.qrSelectedCameraId = deviceId;
      localStorage.setItem('qrLastCameraId', deviceId);
      this.qrVideoReady = false;
      this.qrShowCameraList = false;
      this.qrTorchOn = false;
      this.$nextTick(() => { this._initScanner(); });
    },

    async toggleQrTorch() {
      if (!this._cam2qrScanner) return;
      const newState = !this.qrTorchOn;
      try {
        const supported = await this._cam2qrScanner.setTorch(newState);
        if (supported === false) {
          // P1-4: не роняем сканер — просто тост, сканирование продолжается
          this.showToast('Фонарик не поддерживается этой камерой.');
          return;
        }
        this.qrTorchOn = newState;
      } catch (e) {
        this.showToast('Не удалось включить фонарик. Возможно, камера не поддерживает его.');
      }
    },

    async setQrZoom(value) {
      // P1-4: клампим к реальному диапазону камеры, ошибку показываем тостом
      const v = Math.min(this.qrZoomMax, Math.max(this.qrZoomMin, parseFloat(value)));
      this.qrZoomLevel = v;
      if (this._qrVideoTrack && this.qrZoomSupported) {
        try {
          await this._qrVideoTrack.applyConstraints({
            advanced: [{ zoom: v }]
          });
        } catch (e) {
          this.showToast('Не удалось применить зум. Ваша камера может не поддерживать эту функцию.');
        }
      }
    },

    async _initScanner() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.qrScanError = 'Ваш браузер не поддерживает доступ к камере. Попробуйте Chrome, Firefox или Edge.';
        this.qrScannerState = 'error';
        return;
      }
      const videoEl = document.getElementById('qr-video');
      if (!videoEl) {
        this.qrScanError = 'Элемент видео не найден. Обновите страницу.';
        this.qrScannerState = 'error';
        return;
      }
      try {
        const cam2qr = window.__cam2qr || await import('https://cdn.jsdelivr.net/npm/cam2qr@1.1.1/dist/index.js');
        const { QrScanner } = cam2qr;

        const scanner = new QrScanner(videoEl, {
          camera: this.qrSelectedCameraId
            ? { deviceId: this.qrSelectedCameraId }
            : { facing: 'environment' },
          onDecode: (result) => {
            this.onQrScanSuccess(result.text);
          },
          onError: (error) => {
            if (error.name === 'CameraError') {
              this._handleQrError(error);
              this.qrScannerState = 'error';
            }
          },
          useWorker: false,
          maxScansPerSecond: 10,
          tryInverted: true,
          stopOnDecode: true,
          pauseOnHidden: true,
        });

        this._cam2qrScanner = scanner;
        await scanner.start();
        this.qrVideoReady = true;

        if (videoEl && videoEl.srcObject) {
          const tracks = videoEl.srcObject.getTracks().filter(t => t.kind === 'video');
          if (tracks.length > 0) {
            this._qrVideoTrack = tracks[0];
            try {
              const capabilities = this._qrVideoTrack.getCapabilities();
              if (capabilities.zoom) {
                // P1-4: диапазон слайдера — из возможностей камеры, а не хардкод
                this.qrZoomSupported = true;
                this.qrZoomMin = capabilities.zoom.min ?? 1;
                this.qrZoomMax = capabilities.zoom.max ?? 3;
                this.qrZoomStep = capabilities.zoom.step ?? 0.1;
                this.qrZoomLevel = Math.min(this.qrZoomMax, Math.max(this.qrZoomMin, this.qrZoomLevel || this.qrZoomMin));
              } else {
                this.qrZoomSupported = false;
              }
            } catch (e) {
              this.qrZoomSupported = false;
            }
          } else {
            this.qrZoomSupported = false;
          }
        } else {
          this.qrZoomSupported = false;
        }

        try {
          const cameras = await cam2qr.listCameras();
          this.qrAllCameras = cameras.map(cam => ({
            id: cam.id,
            label: cam.label,
            facing: cam.facing,
          }));
        } catch (e) {
          this.qrAllCameras = [];
        }
      } catch (err) {
        this._handleQrError(err);
      }
    },

    _handleQrError(err) {
      const code = err?.code || '';
      const msg = (err && (err.message || String(err))) || '';
      if (code === 'permission-denied' || msg.includes('NotAllowedError') || msg.includes('Permission denied')) {
        this.qrScanError = 'Доступ к камере запрещён. Разрешите доступ в настройках браузера.';
      } else if (code === 'camera-not-found' || msg.includes('NotFoundError') || msg.includes('Overconstrained')) {
        this.qrScanError = 'Камера не найдена. Подключите камеру к компьютеру.';
      } else if (code === 'camera-in-use' || msg.includes('NotReadableError')) {
        this.qrScanError = 'Камера занята другим приложением. Закройте другие программы.';
      } else if (code === 'insecure-context' || code === 'unsupported' || msg.includes('NotSupported')) {
        this.qrScanError = 'Камера недоступна в этом браузере. '
          + 'Используйте Chrome/Edge/Firefox. '
          + 'Страница должна быть открыта через HTTPS, localhost или 127.0.0.1.';
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('import')) {
        this.qrScanError = 'Не удалось загрузить библиотеку сканирования. Проверьте подключение к интернету.';
      } else {
        this.qrScanError = 'Ошибка: ' + (code || msg.substring(0, 100));
      }
      this.qrScannerState = 'error';
    },

    async onQrScanSuccess(decodedText) {
      if (this.qrScannerState !== 'scanning') {
        return;
      }
      vibrate();
      const product = this.findProductByQrText(decodedText);
      if (!product) {
        this.qrScanError = 'Товар не найден по QR-коду: ' + decodedText.substring(0, 60);
        this.qrScannerState = 'error';
        return;
      }
      this.showToast('Найден: ' + product.name);
      await this.closeQrScanner();
      this.selectProduct(product);
    },

    findProductByQrText(text) {
      const code = this.parseMvideoUrl(text);
      if (code) {
        const p = dataLayer.productByArticle.get(code);
        if (p) return p;
      }
      return findProduct(text);
    },

    parseMvideoUrl(url) {
      const match = url.match(/\/products\/(\d+)/);
      return match ? match[1] : null;
    },

    async restartQrScanner() {
      this._stopScanning();
      this.qrScannerState = 'scanning';
      this.qrScanResult = null;
      this.qrScanError = null;
      this.qrVideoReady = false;
      this.qrTorchOn = false;
      this.$nextTick(() => { this._initScanner(); });
    },

    async closeQrScanner() {
      this._stopScanning();
      this.qrScannerOpen = false;
      this.qrScannerState = 'idle';
      this.qrScanResult = null;
      this.qrScanError = null;
      this.qrVideoReady = false;
      this.qrTorchOn = false;
      this.qrZoomLevel = 1.0;
      this.qrZoomSupported = false;
      this.qrZoomMin = 1;
      this.qrZoomMax = 3;
      this.qrZoomStep = 0.1;
    },

    openMvideoSearch() {
      vibrate();
      this.mvideoViewOpen = true;
      this.mvideoArticle = '';
      this.enteredSection = null;
      this.selectedShelfLevels = null;
      this.activeSection = null;
    },

    closeMvideoSearch() {
      this.mvideoViewOpen = false;
      this.mvideoArticle = '';
    },

    searchOnMvideo() {
      const article = this.mvideoArticle.trim();
      if (!article) return;
      vibrate();
      window.open('https://www.mvideo.ru/products/' + encodeURIComponent(article), '_blank');
    },

    openShelves() {
      vibrate();
      this.shelvesViewOpen = true;
      this.enteredSection = null;
      this.selectedShelfLevels = null;
      this.activeSection = null;
      this.searchQuery = '';
      this.searchInput = '';
    },

    closeShelves() {
      this.shelvesViewOpen = false;
      this.enteredSection = null;
      this.selectedShelfLevels = null;
      this.activeSection = null;
      this.searchQuery = '';
      this.searchInput = '';
    },

  },

  async mounted() {
    const errDiv = document.getElementById('vue-load-error');
    if (errDiv) errDiv.style.display = 'none';
    this.initTheme();
    await this.init();

    // Стартуем всегда с главной: автовосстановление последней секции
    // убрано — после перезагрузки пользователь должен видеть все кнопки.
    // Хэш-навигация (#print, #favorites) обрабатывается ниже как раньше.

    window.addEventListener('online', () => { this.isOffline = false; });
    window.addEventListener('offline', () => { this.isOffline = true; });

    // Очистка области печати после закрытия диалога печати.
    // Чистить синхронно после window.print() нельзя: в мобильных
    // браузерах печать асинхронна и получаются пустые страницы.
    window.addEventListener('afterprint', () => {
      const printArea = document.getElementById('print-area');
      if (printArea) printArea.innerHTML = '';
    });

    // Close modals on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (this.barcodeModalOpen) {
            this.closeBarcodeModal();
          } else if (this.qrScannerOpen) {
            this.closeQrScanner();
          } else if (this.mvideoViewOpen) {
            this.closeMvideoSearch();
          } else if (this.productSearchOpen) {
            this.closeProductSearch();
          } else if (this.shelvesViewOpen) {
            this.closeShelves();
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
