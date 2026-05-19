# PWA генератор штрих-кодов склада — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\- [ ]\) syntax for tracking.

**Goal:** Создать клиентское PWA-приложение для генерации штрих-кодов Code-128 полок склада с офлайн-режимом.

**Architecture:** Vue 3 через CDN, один файл app.js содержит все модули. Навигация через реактивное состояние currentScreen + v-if + Transition. Service Worker для precache. IndexedDB для кэша штрих-кодов.

**Tech Stack:** Vue 3 (CDN), Bootstrap 5 (CDN), JsBarcode (CDN), vanilla JS, IndexedDB

---

## Файловая структура

| Файл | Ответственность |
|------|----------------|
| \scripts/convert_csv.py\ | Конвертация CSV → JS |
| \data/shelves.js\ | Сгенерированные данные полок |
| \icons/icon-192.png\ | PWA иконка 192x192 |
| \icons/icon-512.png\ | PWA иконка 512x512 |
| \manifest.json\ | PWA манифест |
| \sw.js\ | Service Worker |
| \index.html\ | HTML-каркас с CDN ссылками |
| \css/style.css\ | Кастомные стили |
| \js/app.js\ | Vue приложение (все модули) |

---

### Task 1: CSV конвертер и генерация данных

**Files:**
- Create: \scripts/convert_csv.py\
- Create: \data/shelves.js\ (генерируется скриптом)

- [ ] **Step 1: Создать скрипт конвертации**

\\\python
import csv
import json
import os

def convert_csv_to_js(csv_path, js_path):
    shelves = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            shelf = {
                'name': row['name'],
                'barcode': row['barcode'],
                'section': row['section'],
                'type': row['type'],
                'number': row['number'],
                'level': row['level'] if row['level'] else None
            }
            shelves.append(shelf)

    js_content = 'const SHELVES = ' + json.dumps(shelves, ensure_ascii=False, indent=2) + ';'
    os.makedirs(os.path.dirname(js_path), exist_ok=True)
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)

    print(f'Converted {len(shelves)} shelves to {js_path}')

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    csv_path = os.path.join(root_dir, 'warehouse_data.csv')
    js_path = os.path.join(root_dir, 'data', 'shelves.js')
    convert_csv_to_js(csv_path, js_path)
\\\

- [ ] **Step 2: Запустить конвертер**

Run: \python scripts/convert_csv.py\
Expected: \Converted 193 shelves to data/shelves.js\

- [ ] **Step 3: Проверить output**

Убедиться что data/shelves.js содержит const SHELVES = [...] с 193 записями.

---

### Task 2: PWA иконки

**Files:**
- Create: \icons/icon-192.png\
- Create: \icons/icon-512.png\
- Create: \scripts/generate_icons.py\

- [ ] **Step 1: Создать скрипт генерации иконок**

\\\python
from PIL import Image
import os

def generate_icons(source_path, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    img = Image.open(source_path)
    # Конвертация RGBA если нужно
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    # Resize и сохранение
    for size in [192, 512]:
        resized = img.resize((size, size), Image.LANCZOS)
        output_path = os.path.join(output_dir, f'icon-{size}.png')
        resized.save(output_path, 'PNG')
        print(f'Created {output_path} ({size}x{size})')

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    source = os.path.join(root_dir, 'logo_bot.jpg')
    output = os.path.join(root_dir, 'icons')
    generate_icons(source, output)
\\\

- [ ] **Step 2: Запустить генерацию**

Run: \python scripts/generate_icons.py\
Expected: Created icons/icon-192.png и icons/icon-512.png

- [ ] **Step 3: Fallback без Pillow**

Если Pillow не установлен — попробовать установить: \pip install Pillow\. Если не работает — создать иконки вручную (любым способом, даже заглушки).

---

### Task 3: manifest.json

**Files:**
- Create: \manifest.json\

- [ ] **Step 1: Создать manifest.json**

\\\json
{
  "name": "Генератор штрих-кодов склада",
  "short_name": "Штрих-коды",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#0d6efd",
  "icons": [
    {
      "src": "icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
\\\

---

### Task 4: Service Worker (sw.js)

**Files:**
- Create: \sw.js\

- [ ] **Step 1: Создать sw.js с precache**

\\\javascript
const CACHE_NAME = 'barcode-app-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/data/shelves.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
\\\

---

### Task 5: index.html — HTML каркас

**Files:**
- Create: \index.html\

- [ ] **Step 1: Создать index.html**

\\\html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#0d6efd">
  <title>Генератор штрих-кодов склада</title>
  <link rel="manifest" href="manifest.json">
  <link rel="icon" href="icons/icon-192.png" type="image/png">
  <link rel="apple-touch-icon" href="icons/icon-192.png">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="css/style.css" rel="stylesheet">
</head>
<body>
  <div id="app" class="min-vh-100 bg-light">
    <div class="container py-3" v-if="loading">
      <div class="text-center py-5">
        <div class="spinner-border text-primary" role="status"></div>
        <p class="mt-3">Загрузка данных...</p>
      </div>
    </div>
    <div class="container py-3" v-if="error">
      <div class="card border-danger">
        <div class="card-body text-center">
          <h5 class="card-title text-danger">Ошибка загрузки</h5>
          <p class="card-text">Не удалось загрузить данные. Проверьте подключение и обновите страницу.</p>
          <button class="btn btn-danger btn-lg" @click="retryLoad">Повторить</button>
        </div>
      </div>
    </div>
    <div v-if="!loading && !error">
      <!-- Welcome -->
      <div v-if="currentScreen === 'welcome'" class="screen">
        <div class="text-center py-4">
          <h1 class="mb-3">Генератор штрих-кодов</h1>
          <p class="text-muted mb-4">Выберите полку для генерации штрих-кода</p>
          <div class="row g-3 mb-4 justify-content-center">
            <div class="col-6 col-md-3">
              <div class="card text-center">
                <div class="card-body">
                  <h3 class="card-title text-primary">{{ stats.totalSections }}</h3>
                  <small class="text-muted">Секций</small>
                </div>
              </div>
            </div>
            <div class="col-6 col-md-3">
              <div class="card text-center">
                <div class="card-body">
                  <h3 class="card-title text-primary">{{ stats.totalShelves }}</h3>
                  <small class="text-muted">Стеллажей</small>
                </div>
              </div>
            </div>
            <div class="col-6 col-md-3">
              <div class="card text-center">
                <div class="card-body">
                  <h3 class="card-title text-primary">{{ stats.totalPallets }}</h3>
                  <small class="text-muted">Поддонов</small>
                </div>
              </div>
            </div>
            <div class="col-6 col-md-3">
              <div class="card text-center">
                <div class="card-body">
                  <h3 class="card-title text-primary">{{ stats.totalZones }}</h3>
                  <small class="text-muted">Служебных зон</small>
                </div>
              </div>
            </div>
          </div>
          <button class="btn btn-primary btn-lg py-3 px-5" @click="push('sections')">Начать</button>
        </div>
      </div>

      <!-- Sections -->
      <div v-if="currentScreen === 'sections'" class="screen">
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" @click="home">На главную</button>
        </div>
        <h2 class="mb-3">Секции</h2>
        <div class="row g-3">
          <div v-for="sec in sectionList" :key="sec.name" class="col-6 col-md-4">
            <button class="btn btn-outline-primary btn-lg w-100 py-3" @click="selectSection(sec.name)">
              {{ sec.label }}
              <br><small class="text-muted">{{ sec.count }} полок</small>
            </button>
          </div>
        </div>
      </div>

      <!-- Storage Type -->
      <div v-if="currentScreen === 'storageType'" class="screen">
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" @click="back">Назад</button>
          <button class="btn btn-outline-secondary" @click="home">На главную</button>
        </div>
        <h2 class="mb-3">{{ selectedSection }} — Тип хранения</h2>
        <div class="row g-3">
          <div v-if="hasRacks" class="col-6">
            <button class="btn btn-primary btn-lg w-100 py-3" @click="push('racks')">Стеллажи</button>
          </div>
          <div v-if="hasPallets" class="col-6">
            <button class="btn btn-primary btn-lg w-100 py-3" @click="push('pallets')">Поддоны</button>
          </div>
        </div>
      </div>

      <!-- Racks -->
      <div v-if="currentScreen === 'racks'" class="screen">
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" @click="back">Назад</button>
          <button class="btn btn-outline-secondary" @click="home">На главную</button>
        </div>
        <h2 class="mb-3">{{ selectedSection }} — Стеллажи</h2>
        <div class="row g-2">
          <div v-for="rack in paginatedRacks" :key="rack.name" class="col-6 col-md-4">
            <button class="btn btn-outline-primary btn-lg w-100 py-3" @click="selectRack(rack)">
              {{ rack.name }}
            </button>
          </div>
        </div>
        <nav-pagination v-if="racksTotalPages > 1" :page="pagination.page" :total="racksTotalPages" @change="pagination.page = " />
      </div>

      <!-- Levels -->
      <div v-if="currentScreen === 'levels'" class="screen">
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" @click="back">Назад</button>
          <button class="btn btn-outline-secondary" @click="home">На главную</button>
        </div>
        <h2 class="mb-3">{{ selectedRack.name }} — Уровни</h2>
        <div class="row g-2">
          <div v-for="lvl in levels" :key="lvl.level" class="col-6">
            <button class="btn btn-outline-primary btn-lg w-100 py-3" @click="selectShelf(lvl)">
              Уровень {{ lvl.level }}
            </button>
          </div>
        </div>
      </div>

      <!-- Pallets -->
      <div v-if="currentScreen === 'pallets'" class="screen">
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" @click="back">Назад</button>
          <button class="btn btn-outline-secondary" @click="home">На главную</button>
        </div>
        <h2 class="mb-3">{{ selectedSection }} — Поддоны</h2>
        <div class="row g-2">
          <div v-for="pallet in paginatedPallets" :key="pallet.name" class="col-6 col-md-4">
            <button class="btn btn-outline-primary btn-lg w-100 py-3" @click="selectShelf(pallet)">
              {{ pallet.name }}
            </button>
          </div>
        </div>
        <nav-pagination v-if="palletsTotalPages > 1" :page="pagination.page" :total="palletsTotalPages" @change="pagination.page = " />
      </div>

      <!-- Zones -->
      <div v-if="currentScreen === 'zones'" class="screen">
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" @click="back">Назад</button>
          <button class="btn btn-outline-secondary" @click="home">На главную</button>
        </div>
        <h2 class="mb-3">Служебные зоны</h2>
        <div class="row g-2">
          <div v-for="zone in zones" :key="zone.name" class="col-6">
            <button class="btn btn-outline-primary btn-lg w-100 py-3" @click="selectShelf(zone)">
              {{ zone.name }}
            </button>
          </div>
        </div>
      </div>

      <!-- Pickup -->
      <div v-if="currentScreen === 'pickup'" class="screen">
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" @click="back">Назад</button>
          <button class="btn btn-outline-secondary" @click="home">На главную</button>
        </div>
        <h2 class="mb-3">ПИКАП</h2>
        <div class="row g-2">
          <div v-for="pallet in pickupPallets" :key="pallet.name" class="col-6">
            <button class="btn btn-outline-primary btn-lg w-100 py-3" @click="selectShelf(pallet)">
              {{ pallet.name }}
            </button>
          </div>
        </div>
      </div>

      <!-- Barcode -->
      <div v-if="currentScreen === 'barcode'" class="screen">
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" @click="home">На главную</button>
        </div>
        <div class="card">
          <div class="card-body text-center">
            <h3 class="mb-3">{{ currentBarcodeShelf ? currentBarcodeShelf.name : '' }}</h3>
            <div id="barcode-container" class="mb-3"></div>
            <div v-if="barcodeError" class="alert alert-danger">
              {{ barcodeError }}
            </div>
            <div class="d-flex flex-column gap-2">
              <button class="btn btn-success btn-lg py-3" @click="downloadPNG" :disabled="!barcodePng">Скачать PNG</button>
              <button class="btn btn-primary btn-lg py-3" @click="home">Ещё штрих-код</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/vue@3.4.21/dist/vue.global.prod.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
  <script src="data/shelves.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
\\\

---

### Task 6: css/style.css

**Files:**
- Create: \css/style.css\

- [ ] **Step 1: Создать стили**

\\\css
* {
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-tap-highlight-color: transparent;
}

.screen {
  min-height: calc(100vh - 2rem);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

#barcode-container svg {
  max-width: 100%;
  height: auto;
}

.btn-lg {
  min-height: 48px;
}

.card {
  border-radius: 0.75rem;
}
\\\

---

### Task 7: js/app.js — Модули данных и утилиты

**Files:**
- Create: \js/app.js\

- [ ] **Step 1: Создать js/app.js с модулями DataLayer, Translit, BarcodeCache, BarcodeGenerator, Pagination**

\\\javascript
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
class BarcodeCache {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('barcode-cache', 1);
      request.onupgradeneeded = (e) => {
        e.target.result.createObjectStore('barcodes');
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
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('barcodes', 'readonly');
      const req = tx.objectStore('barcodes').get(key);
      req.onsuccess = () => resolve(req.result || undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async put(key, value) {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('barcodes', 'readwrite');
      tx.objectStore('barcodes').put(value, key);
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
    const cached = await this.cache.get(barcode);
    if (cached) return cached;

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
        sections.push({ name, count, hasRacks: data.racks.length > 0, hasPallets: data.pallets.length > 0 });
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
\\\

---

### Task 8: js/app.js — Vue приложение и навигация

**Files:**
- Modify: \js/app.js\ (добавить в конец файла)

- [ ] **Step 1: Добавить Vue приложение**

\\\javascript
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
      selectedSection: null,
      selectedRack: null,
      currentBarcodeShelf: null,
      barcodeSvg: '',
      barcodePng: null,
      barcodeError: null,
      pagination: { page: 1, perPage: 12 },
      error: null,
      loading: true,
      stats: { totalSections: 0, totalShelves: 0, totalPallets: 0, totalZones: 0 }
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
    }
  },

  methods: {
    push(screen) {
      this.navStack.push(this.currentScreen);
      this.pagination.page = 1;
      this.currentScreen = screen;
    },

    back() {
      if (this.navStack.length > 0) {
        this.currentScreen = this.navStack.pop();
        this.pagination.page = 1;
      } else {
        this.home();
      }
    },

    home() {
      this.navStack = [];
      this.currentScreen = 'welcome';
      this.selectedSection = null;
      this.selectedRack = null;
      this.currentBarcodeShelf = null;
      this.barcodeSvg = '';
      this.barcodePng = null;
      this.barcodeError = null;
      this.pagination.page = 1;
    },

    selectSection(name) {
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
      this.selectedRack = rack;
      const rackLevels = this.racks.filter(r => r.number === rack.number);
      if (rackLevels.length <= 1) {
        // Только один уровень — сразу штрих-код
        this.selectShelf(rack);
      } else {
        this.push('levels');
      }
    },

    async selectShelf(shelf) {
      this.currentBarcodeShelf = shelf;
      this.barcodeError = null;
      this.barcodeSvg = '';
      this.barcodePng = null;
      this.push('barcode');
      await this.generateBarcode(shelf);
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
        this.(() => {
          const container = document.getElementById('barcode-container');
          if (container) {
            container.innerHTML = result.svg;
          }
        });
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
        this.loading = false;
      } catch (e) {
        this.loading = false;
        this.error = 'Не удалось загрузить данные. Проверьте подключение и обновите страницу.';
      }
    }
  },

  async mounted() {
    await this.init();
  }
});

// Простой компонент пагинации
app.component('nav-pagination', {
  props: ['page', 'total'],
  emits: ['change'],
  template: \
    <nav class="mt-3">
      <ul class="pagination justify-content-center">
        <li class="page-item" :class="{ disabled: page <= 1 }">
          <button class="page-link" @click="('change', page - 1)" :disabled="page <= 1">Назад</button>
        </li>
        <li v-for="p in visiblePages" :key="p" class="page-item" :class="{ active: p === page }">
          <button class="page-link" @click="('change', p)">{{ p }}</button>
        </li>
        <li class="page-item" :class="{ disabled: page >= total }">
          <button class="page-link" @click="('change', page + 1)" :disabled="page >= total">Вперёд</button>
        </li>
      </ul>
    </nav>
  \,
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
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
\\\

---

### Task 9: Интеграция и проверка

**Files:**
- Все файлы проекта

- [ ] **Step 1: Проверить структуру файлов**

Убедиться что все файлы на месте:
- index.html, css/style.css, js/app.js, data/shelves.js
- scripts/convert_csv.py, manifest.json, sw.js
- icons/icon-192.png, icons/icon-512.png

- [ ] **Step 2: Запустить локальный сервер для проверки**

Run: \python -m http.server 8080\
Открыть: http://localhost:8080

Проверить:
1. Загрузка данных и статистика на Welcome
2. Навигация по секциям
3. Выбор стеллажа → уровни → штрих-код
4. Выбор поддона → штрих-код
5. Служебные зоны → штрих-код
6. ПИКАП → штрих-код
7. Кнопка "Скачать PNG"
8. Кнопки "Назад" и "На главную"
9. Пагинация при > 12 элементов
10. Если стеллаж имеет 1 уровень — сразу штрих-код
11. Если секция имеет только один тип — пропуск экрана выбора типа
