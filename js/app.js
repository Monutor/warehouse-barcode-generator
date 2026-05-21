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
    const cachedPng = await this.cache.get(barcode);
    if (cachedPng) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      JsBarcode(svg, barcode, {
        format: 'CODE128',
        width: 2,
        height: 80,
        displayValue: true,
        text: shelfName,
        fontSize: 16,
        margin: 10
      });
      return { svg: new XMLSerializer().serializeToString(svg), pngDataUrl: cachedPng };
    }

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
        const pngDataUrl = canvas.toDataURL('image/png');
        this.cache.put(barcode, pngDataUrl).catch(() => {});
        resolve({ svg: svgString, pngDataUrl });
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

// === DataLayer ===
class DataLayer {
  constructor() {
    this.shelves = [];
    this.nameIndex = new Map();
    this.sectionIndex = new Map();
  }

  async load() {
    if (typeof SHELVES === 'undefined') {
      throw new Error('Данные не загружены');
    }
    this.shelves = SHELVES;
    this.buildIndexes();
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

const app = Vue.createApp({
  data() {
    return {
      currentScreen: 'welcome',
      navStack: [],
      shelves: [],
      searchQuery: '',
      selectedSection: null,
      selectedRack: null,
      currentBarcodeShelf: null,
      barcodeSvg: '',
      barcodePng: null,
      barcodeError: null,
      barcodeLoading: false,
      pagination: { page: 1, perPage: 12 },
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
      scannerActive: false,
      scannerError: null,
      scannedCode: null,
      scanResult: null,
      scannerInstance: null
    };
  },

  computed: {
    sectionList() {
      return dataLayer.getSections();
    },

    currentSectionData() {
      return dataLayer.getSection(this.selectedSection);
    },

    hasRacks() {
      return this.currentSectionData.racks.length > 0;
    },

    hasPallets() {
      return this.currentSectionData.pallets.length > 0;
    },

    racks() {
      return this.currentSectionData.racks;
    },

    racksTotalPages() {
      return Math.ceil(this.racks.length / this.pagination.perPage);
    },

    paginatedRacks() {
      return paginate(this.racks, this.pagination.page, this.pagination.perPage).items;
    },

    pallets() {
      return this.currentSectionData.pallets;
    },

    palletsTotalPages() {
      return Math.ceil(this.pallets.length / this.pagination.perPage);
    },

    paginatedPallets() {
      return paginate(this.pallets, this.pagination.page, this.pagination.perPage).items;
    },

    levels() {
      if (!this.selectedRack) return [];
      return this.racks.filter(r => r.number === this.selectedRack.number).sort((a, b) => {
        return (a.level || '').localeCompare(b.level || '', 'ru', { numeric: true });
      });
    },

    zones() {
      return dataLayer.getSection('СЛУЖЕБНАЯ').zones;
    },

    pickupPallets() {
      return dataLayer.getSection('ПИКАП').pallets;
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
      return dataLayer.shelves.filter(shelf =>
        shelf.name.toLowerCase().includes(q) ||
        (shelf.barcode && shelf.barcode.toLowerCase().includes(q))
      ).slice(0, 50);
    }
  },

  methods: {
    push(screen) {
      vibrate();
      this.navStack.push(this.currentScreen);
      this.pagination.page = 1;
      this.currentScreen = screen;
    },

    back() {
      vibrate();
      if (this.currentScreen === 'scanner') {
        this.stopScanner();
      }
      if (this.navStack.length > 0) {
        this.currentScreen = this.navStack.pop();
        this.pagination.page = 1;
      } else {
        this.home();
      }
    },

    home() {
      vibrate();
      this.stopScanner();
      this.navStack = [];
      this.currentScreen = 'welcome';
      this.selectedSection = null;
      this.selectedRack = null;
      this.currentBarcodeShelf = null;
      this.barcodeSvg = '';
      this.barcodePng = null;
      this.barcodeError = null;
      this.barcodeLoading = false;
      this.pagination.page = 1;
      this.searchQuery = '';
      this.scannerError = null;
      this.scannedCode = null;
      this.scanResult = null;
    },

    selectSection(name) {
      vibrate();
      this.selectedSection = name;
      this.pagination.page = 1;
      const data = dataLayer.getSection(name);

      if (name === 'СЛУЖЕБНАЯ') {
        this.push('zones');
      } else if (name === 'ПИКАП') {
        this.push('pickup');
      } else if (data.racks.length > 0 && data.pallets.length > 0) {
        this.push('storageType');
      } else if (data.racks.length > 0) {
        this.push('racks');
      } else if (data.pallets.length > 0) {
        this.push('pallets');
      }
    },

    selectRack(rack) {
      vibrate();
      this.selectedRack = rack;
      const rackLevels = this.racks.filter(r => r.number === rack.number);
      if (rackLevels.length <= 1) {
        this.selectShelf(rack);
      } else {
        this.push('levels');
      }
    },

    async selectShelf(shelf) {
      vibrate();
      this.currentBarcodeShelf = shelf;
      this.barcodeError = null;
      this.barcodeSvg = '';
      this.barcodePng = null;
      this.barcodeLoading = true;
      this.push('barcode');
      try {
        await this.generateBarcode(shelf);
      } finally {
        this.barcodeLoading = false;
      }
    },

    async generateBarcode(shelf) {
      try {
        let barcode = shelf.barcode;
        if (!barcode) {
          barcode = transliterate(shelf.name);
        }
        const result = await barcodeGenerator.generate(barcode, shelf.name);
        this.barcodeSvg = result.svg;
        this.barcodePng = result.pngDataUrl;
      } catch (e) {
        this.barcodeError = e.message || 'Ошибка генерации штрих-кода';
      }
    },

    downloadPNG() {
      if (!this.barcodePng) return;
      const link = document.createElement('a');
      link.download = this.currentBarcodeShelf.name + '.png';
      link.href = this.barcodePng;
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
        await dataLayer.load();
        this.stats = dataLayer.getStats();
        this.dataVersion = typeof DATA_VERSION !== 'undefined' ? DATA_VERSION : '';
        this.dataUpdatedAt = typeof DATA_UPDATED_AT !== 'undefined' ? DATA_UPDATED_AT : '';
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

    toggleTheme() {
      this.isDark = !this.isDark;
      document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
      localStorage.setItem('theme', this.isDark ? 'dark' : 'light');
      document.querySelector('meta[name="theme-color"]').content = this.isDark ? '#1a1a2e' : '#0d6efd';
    },

    initTheme() {
      const saved = localStorage.getItem('theme');
      if (saved) {
        this.isDark = saved === 'dark';
      } else {
        this.isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
      document.querySelector('meta[name="theme-color"]').content = this.isDark ? '#1a1a2e' : '#0d6efd';
    },

    async startScanner() {
      if (typeof Html5Qrcode === 'undefined') {
        this.scannerError = 'Библиотека сканера не загружена. Обновите страницу.';
        return;
      }
      this.scannerError = null;
      this.scannedCode = null;
      this.scanResult = null;
      try {
        const scanner = new Html5Qrcode('scanner-reader');
        this.scannerInstance = scanner;
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras || cameras.length === 0) {
          this.scannerError = 'Нет доступа к камере. Разрешите доступ в настройках браузера.';
          return;
        }
        const rearCamera = cameras.find(c => c.label.toLowerCase().includes('back')) || cameras[cameras.length - 1];
        await scanner.start(
          rearCamera.id,
          { fps: 10, qrbox: { width: 250, height: 150 } },
          (decodedText) => this.onScanSuccess(decodedText),
          () => {}
        );
        this.scannerActive = true;
      } catch (e) {
        this.scannerError = 'Нет доступа к камере. Разрешите доступ в настройках браузера.';
      }
    },

    async stopScanner() {
      if (this.scannerInstance && this.scannerActive) {
        try {
          await this.scannerInstance.stop();
          this.scannerInstance.clear();
        } catch {}
        this.scannerInstance = null;
        this.scannerActive = false;
      }
    },

    async onScanSuccess(decodedText) {
      await this.stopScanner();
      this.scannedCode = decodedText;
      const shelf = dataLayer.findByBarcode(decodedText);
      if (shelf) {
        this.currentBarcodeShelf = shelf;
        this.barcodeError = null;
        this.barcodeSvg = '';
        this.barcodePng = null;
        this.barcodeLoading = true;
        this.navStack.push('scanner');
        this.currentScreen = 'barcode';
        try {
          await this.generateBarcode(shelf);
        } finally {
          this.barcodeLoading = false;
        }
      } else {
        this.scanResult = 'not-found';
        this.navStack.push('scanner');
        this.currentScreen = 'scan-not-found';
      }
    },

    async copyScannedCode() {
      if (!this.scannedCode) return;
      try {
        await navigator.clipboard.writeText(this.scannedCode);
        this.showToast('Код скопирован');
      } catch {
        this.showToast('Не удалось скопировать');
      }
    },

    scanAgain() {
      this.scannerError = null;
      this.scannedCode = null;
      this.scanResult = null;
      this.currentScreen = 'scanner';
    }
  },

  watch: {
    currentScreen(newScreen) {
      if (newScreen === 'scanner' && !this.scannerActive && !this.scannerError) {
        this.startScanner();
      }
    }
  },

  async mounted() {
    const errDiv = document.getElementById('vue-load-error');
    if (errDiv) errDiv.style.display = 'none';
    this.initTheme();
    await this.init();
    window.addEventListener('online', () => { this.isOffline = false; });
    window.addEventListener('offline', () => { this.isOffline = true; });
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
