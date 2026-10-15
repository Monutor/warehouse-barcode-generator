import gzip
import json
import os
import sys
from datetime import datetime, timezone

# Поля db.json, которые попадают в products.json
REQUIRED_KEYS = ['Код товара', 'Наименование', 'ШК товара']
# Поле с фактической датой обновления товара в МСК
CHANGED_KEY = 'Последнее изменение МСК'
CHANGED_FMT = '%d.%m.%Y %H:%M:%S'

def read_source(path):
    """Читает db.json. Файл может быть обычным JSON или gzip —
    определяем по сигнатуре 1f 8b, чтобы не гадать по расширению."""
    with open(path, 'rb') as f:
        raw = f.read()
    if len(raw) >= 2 and raw[0] == 0x1f and raw[1] == 0x8b:
        print(f'{path}: gzip, распаковываю...')
        raw = gzip.decompress(raw)
    else:
        print(f'{path}: обычный JSON')
    return raw.decode('utf-8')

def iter_records(text):
    """Отдаёт записи по одной, разбирая плоский массив на лету.
    db.json в развёрнутом виде — 171 МБ; json.loads целиком съел бы
    гигабайты памяти на графе объектов, поэтому идём по raw_decode."""
    # Корень — либо массив, либо объект с ключом products
    try:
        root_is_object = text.lstrip()[0] == '{'
    except IndexError:
        raise SystemExit('db.json пуст')
    if root_is_object:
        key_pos = text.find('"products"')
        if key_pos == -1:
            raise SystemExit('В db.json нет ключа "products"')
        start = text.index('[', key_pos)
    else:
        start = text.index('[')

    decoder = json.JSONDecoder()
    i = start + 1
    n = len(text)
    while True:
        while i < n and text[i] in ' \t\r\n,':
            i += 1
        if i >= n or text[i] == ']':
            return
        record, i = decoder.raw_decode(text, i)
        yield record

def convert_db_to_products(db_path, json_path):
    text = read_source(db_path)

    products = {}
    seen_barcodes = {}
    dup_articles = 0
    dup_barcodes = 0
    skipped = 0
    latest_change = None

    for record in iter_records(text):
        if not isinstance(record, dict):
            skipped += 1
            continue
        article = str(record.get('Код товара') or '').strip()
        name = str(record.get('Наименование') or '').strip()
        barcode = str(record.get('ШК товара') or '').strip()
        # Тот же фильтр, что в js/app.js _parseProducts — иначе записи
        # всё равно вылетят при разборе в браузере
        if not (article and name and barcode):
            skipped += 1
            continue
        if article in products:
            dup_articles += 1
            if dup_articles <= 10:
                print(f'ВНИМАНИЕ: дубль артикула {article!r} (оставлен первый)')
            continue
        if barcode in seen_barcodes:
            dup_barcodes += 1
            if dup_barcodes <= 10:
                print(f'ВНИМАНИЕ: ШК {barcode!r} уже у артикула '
                      f'{seen_barcodes[barcode]!r} (оставлен первый)')
        else:
            seen_barcodes[barcode] = article

        products[article] = {
            'article': article,
            'name': name,
            'barcode': barcode
        }

        changed = record.get(CHANGED_KEY)
        if changed:
            try:
                dt = datetime.strptime(str(changed).strip(), CHANGED_FMT)
                if latest_change is None or dt > latest_change:
                    latest_change = dt
            except ValueError:
                pass

    now = datetime.now(timezone.utc)
    version = now.strftime('%Y%m%d%H%M%S')
    # Дата данных, а не дата конвертации: в UI она показывается как
    # «обновлено», и ставить туда время запуска скрипта — враньё
    updated_at = (latest_change.replace(tzinfo=timezone.utc)
                  .strftime('%Y-%m-%dT%H:%M:%SZ') if latest_change
                  else now.strftime('%Y-%m-%dT%H:%M:%SZ'))

    os.makedirs(os.path.dirname(json_path), exist_ok=True)
    # Без indent: 272K записей с отступами раздувают файл примерно вдвое,
    # а читается он через JSON.parse — выигрыш только в размере
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({
            'version': version,
            'updatedAt': updated_at,
            'products': list(products.values())
        }, f, ensure_ascii=False, separators=(',', ':'))

    size_mb = os.path.getsize(json_path) / 1048576
    print(f'Converted {len(products)} products to {json_path}')
    print(f'Version: {version} | Updated (по данным): {updated_at}')
    print(f'Размер: {size_mb:.1f} МБ')
    if dup_articles:
        print(f'ВНИМАНИЕ: дублей артикулов пропущено: {dup_articles}')
    if dup_barcodes:
        print(f'ВНИМАНИЕ: повторов ШК: {dup_barcodes}')
    if skipped:
        print(f'ВНИМАНИЕ: пропущено записей без артикула/названия/ШК: {skipped}')

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    db_path = os.path.join(root_dir, 'db.json')
    if not os.path.exists(db_path):
        raise SystemExit(
            f'Файл не найден: {db_path}. Положите db.json в корень репозитория.'
        )
    convert_db_to_products(db_path, os.path.join(root_dir, 'data', 'products.json'))
