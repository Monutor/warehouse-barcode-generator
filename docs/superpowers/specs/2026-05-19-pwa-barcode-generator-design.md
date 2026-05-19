# Design Spec: PWA генератор штрих-кодов склада

**Дата:** 2026-05-19
**Статус:** На согласовании

---

## Обзор

Клиентское PWA-приложение для генерации штрих-кодов Code-128 полок склада. Работает полностью офлайн после первого визита. Хостится на GitHub Pages.

## Стек

- Vue 3 через CDN (без сборки)
- Bootstrap 5 через CDN
- JsBarcode (CDN) для Code-128
- manifest.json + sw.js для PWA
- IndexedDB для кэша штрих-кодов

## Структура файлов

`
/
├── index.html
├── css/
│   └── style.css
├── js/
│   └── app.js
├── data/
│   └── shelves.js
├── scripts/
│   └── convert_csv.py
├── manifest.json
├── sw.js
└── icons/
    ├── icon-192.png
    └── icon-512.png
`

## Архитектура приложения

### Единый Vue 3 app (js/app.js)

Все модули внутри одного файла app.js. Навигация через реактивное состояние currentScreen + v-if + Transition.

### Модули (внутренние объекты)

1. **DataLayer** — загрузка shelves.js, построение индексов
   - loadShelves() — fetch data/shelves.js
   - buildIndexes(shelves) → { nameIndex, sectionIndex }
   - getSection(section) → { racks, pallets, zones }
   - findShelf(name) → shelf или null

2. **Translit** — маппинг кириллица → латиница (только заглавные)
   - А→A, Б→B, В→V, Г→G, Д→D, Е→E, Ж→ZH, З→Z, И→I, Й→Y, К→K, Л→L, М→M, Н→N, О→O, П→P, Р→R, С→S, Т→T, У→U, Ф→F, Х→KH, Ц→TS, Ч→CH, Ш→SH, Щ→SHCH, Ы→Y, Э→E, Ю→YU, Я→YA

3. **BarcodeCache** — IndexedDB обёртка
   - init() → открытие БД barcode-cache
   - get(key) → Promise<dataUrl|undefined>
   - put(key, dataUrl) → Promise<void>

4. **BarcodeGenerator** — обёртка над JsBarcode
   - generate(barcode, shelfName) → { svg, pngDataUrl }
   - Fallback если JsBarcode не загружен

5. **Pagination** — утилита
   - paginate(items, page, perPage) → { items, totalPages, hasPrev, hasNext }

### Навигация

Экраны (v-if + Transition):
1. Welcome — приветствие, статистика, кнопка Начать
2. Sections — карточки секций, Служебные зоны в конце
3. StorageType — Стеллажи или Поддоны (ТОЛЬКО если оба типа в секции)
4. Racks — список стеллажей → клик → уровни или штрих-код
5. Levels — список уровней → клик → штрих-код
6. Pallets — список поддонов → клик → штрих-код
7. Zones — список служебных зон → клик → штрих-код
8. Barcode — Code-128 SVG + название + Скачать PNG + Ещё штрих-код
9. Pickup — список поддонов ПИКАП → клик → штрих-код

Навигационный стек: push(screen), back(), home()

Логика из Sections:
- СЛУЖЕБНАЯ → zones
- ПИКАП → pickup
- Только racks → racks
- Только pallets → pallets
- Оба типа → storageType

### Группировка данных

sectionIndex: Map<section, { racks, pallets, zones }>
- racks: type === 'С'
- pallets: type === 'П'
- zones: section === 'СЛУЖЕБНАЯ'

### Обработка ошибок

- shelves.js не загрузился: дружелюбное сообщение + Повторить
- Полка не найдена: Штрих-код не найден для: name
- JsBarcode не загрузился: ошибка с предложением обновить

### UI/UX

- Bootstrap 5: btn, card, container, row, col, d-flex, gap
- Мобильно-ориентированный дизайн
- Крупные кнопки: btn-lg, py-3
- Пагинация при > 12 элементов
- Vue Transition для переходов
- Только русский язык

### PWA

manifest.json: name, short_name, start_url, display: standalone, icons 192/512
sw.js: precache при install, cache-first при fetch, очистка старых кэшей при activate

### CSV конвертер

scripts/convert_csv.py: читает warehouse_data.csv, генерирует data/shelves.js
Пустой level → null

### Статистика (Welcome)

- total_sections: уникальные section (искл. СЛУЖЕБНАЯ, ПИКАП)
- total_shelves: type === 'С'
- total_zones: section === 'СЛУЖЕБНАЯ'
- total_pallets: type === 'П'
