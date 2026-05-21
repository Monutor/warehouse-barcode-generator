# Spec: Barcode Scanner Feature

## Purpose

Allow users to scan physical barcode stickers using their phone camera and instantly view the corresponding shelf information and generated barcode image.

## User Flow

1. User taps scanner button (on welcome screen or in header)
2. App navigates to scanner screen, activates rear camera
3. User points camera at a barcode
4. Library detects and decodes the barcode value
5. App searches the barcode value in `SHELVES` data
6. If found → navigate to barcode screen showing the shelf's barcode image
7. If not found → show warning screen with the scanned code, copy button, and "scan again" button

## Architecture

### New Screen: `scanner`

A dedicated Vue screen managed by the existing navigation system (`push('scanner')` / `back()`).

**State (Vue `data`):**
- `scannerActive: boolean` — is the scanner currently running
- `scannerError: string | null` — error message (camera permission denied, etc.)
- `scannedCode: string | null` — raw scanned barcode value
- `scanResult: 'not-found' | null` — whether the scanned code was not found in DB

**Lifecycle:**
- `mounted()`: start `Html5QrcodeScanner` with rear camera
- `beforeUnmount()`: stop and clear scanner to release camera

### DataLayer Extension

Add `findByBarcode(code: string)` method to `DataLayer`:
- Search `SHELVES` by `barcode` field first
- If not found, search by `name` field (fallback)
- Return the shelf object or `null`

### html5-qrcode Integration

- Load from CDN: `https://cdn.jsdelivr.net/npm/html5-qrcode@3.2.0/html5-qrcode.min.js`
- Use `Html5Qrcode` class directly (not the full scanner UI) for custom UI control
- Configuration:
  - `fps: 10`
  - `qrbox: { width: 250, height: 150 }` — rectangular box for barcode
  - `formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128]`
  - `camera: { facingMode: "environment" }`

### CDN Asset

Add `html5-qrcode` CDN URL to `sw.js` `CDN_ASSETS` array for offline caching.

## UI Changes

### index.html

**Welcome screen:** Add scanner button below "Начать":
```html
<button class="btn btn-outline-dark btn-lg py-3 px-5 mt-2" @click="push('scanner')">
  📷 Сканировать штрих-код
</button>
```

**All screens (header):** Add scanner icon button in the header next to existing buttons:
```html
<button class="btn btn-sm btn-outline-secondary" @click="push('scanner')" aria-label="Сканировать">📷</button>
```

**New scanner screen:** Full-screen camera view with:
- `<div id="scanner-reader">` container for html5-qrcode
- Overlay text: "Наведите камеру на штрих-код"
- Cancel button: "Отмена" (calls `back()`)
- Error display if camera permission denied

**Not-found screen:** Card with:
- Warning icon + "Штрих-код не найден в базе"
- Display the scanned code
- "Скопировать" button (copies code to clipboard)
- "Сканировать ещё" button (goes back to scanner)

### js/app.js

**New methods:**
- `startScanner()` — initializes Html5Qrcode, starts camera, sets up success/error callbacks
- `stopScanner()` — stops and clears the scanner
- `onScanSuccess(decodedText)` — looks up shelf, navigates to barcode or not-found
- `copyScannedCode()` — copies `scannedCode` to clipboard

**Cleanup on navigation:** When leaving the scanner screen (back/home), call `stopScanner()` to release the camera.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Camera permission denied | Show `scannerError` message with text "Нет доступа к камере. Разрешите доступ в настройках браузера." |
| No camera available | Same as above |
| Barcode not in database | Show not-found screen with scanned code |
| JsBarcode not loaded | Existing error handling covers this |
| html5-qrcode fails to load | Show error in `vue-load-error` style block |

## Files Modified

1. `index.html` — scanner screen HTML, scanner buttons on welcome and headers
2. `js/app.js` — scanner state, methods, DataLayer extension
3. `sw.js` — add html5-qrcode CDN URL to `CDN_ASSETS`, bump cache version
