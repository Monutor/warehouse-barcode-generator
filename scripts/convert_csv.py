import csv
import glob
import json
import os
import re
from datetime import datetime, timezone

# P1-7: единая проверка заголовков — вместо cryptic KeyError
def check_headers(fieldnames, required, csv_path):
    missing = [h for h in required if h not in (fieldnames or [])]
    if missing:
        raise SystemExit(
            f'В {csv_path} нет колонок: {missing}. '
            f'Найдены: {fieldnames}. Проверьте разделитель (нужен ";") и названия колонок.'
        )

# P1-7: нормализация уровней ('1_' -> '1', '2.' -> '2'); мусор — в предупреждения
def normalize_level(level, warnings):
    if level is None:
        return None
    level = str(level).strip()
    m = re.search(r'\d+', level)
    norm = m.group(0) if m else level
    if norm != level or (norm.isdigit() and len(norm) > 1):
        warnings.append(f'подозрительный уровень {level!r} -> {norm!r}')
    return norm

def parse_main_cell(name, barcode):
    parts = name.split('-')
    if len(parts) == 1:
        return None
    section = parts[0]
    second = parts[1]
    # P1-7: защита от IndexError на именах вида 'Л--1' (пустой second)
    if not second:
        return None
    has_level = len(parts) == 3
    if second.startswith('С') or second.startswith('П'):
        stype = second[0]
        number = second[1:]
    elif second.isdigit() or (second[0].isdigit() and len(second) > 0):
        stype = 'С' if has_level else 'П'
        number = second
    else:
        return None
    level = parts[2] if has_level else None
    return {
        'name': name,
        'barcode': barcode,
        'section': section,
        'type': stype,
        'number': number,
        'level': level
    }

def convert_csv_to_json(csv_path, json_path):
    shelves = []
    level_warnings = []
    seen_names = {}
    dup_names = 0
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        check_headers(reader.fieldnames,
                      ['Код зоны', 'Ячейка', 'ШК'], csv_path)
        for row in reader:
            code = (row.get('Код зоны') or '').strip()
            cell = (row.get('Ячейка') or '').strip()
            barcode = (row.get('ШК') or '').strip()
            if not cell:
                continue
            if code == 'Main':
                shelf = parse_main_cell(cell, barcode)
                if shelf:
                    shelf['level'] = normalize_level(shelf['level'], level_warnings)
                    shelves.append(shelf)
            elif code == 'Pickup':
                number = cell.split('-')[-1] if '-' in cell else cell
                shelves.append({
                    'name': cell,
                    'barcode': barcode,
                    'section': 'ПИКАП',
                    'type': 'П',
                    'number': number,
                    'level': None
                })
            else:
                shelves.append({
                    'name': cell,
                    'barcode': barcode,
                    'section': 'СЛУЖЕБНАЯ',
                    'type': 'З',
                    'number': cell.upper(),
                    'level': None
                })
            # P1-7: дубли имён с разными ШК — предупреждаем, а не молчим
            prev = seen_names.get(cell)
            if prev is None:
                seen_names[cell] = barcode
            elif prev != barcode:
                dup_names += 1
                if dup_names <= 10:
                    print(f'ВНИМАНИЕ: дубль имени {cell!r}: {prev!r} vs {barcode!r}')

    # P1-7: единый формат версии (строка %Y%m%d%H%M%S) для обоих JSON
    now = datetime.now(timezone.utc)
    version = now.strftime('%Y%m%d%H%M%S')
    updated_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')

    os.makedirs(os.path.dirname(json_path), exist_ok=True)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({
            'version': version,
            'updatedAt': updated_at,
            'shelves': shelves
        }, f, ensure_ascii=False, indent=2)

    print(f'Converted {len(shelves)} shelves to {json_path}')
    print(f'Version: {version} | Updated: {updated_at}')
    if dup_names:
        print(f'ВНИМАНИЕ: дублей имён с разными ШК: {dup_names}')
    if level_warnings:
        print(f'ВНИМАНИЕ: подозрительных уровней: {len(level_warnings)}')
        for w in level_warnings[:10]:
            print(f'  - {w}')

def convert_products_to_json(csv_path, json_path):
    products = {}
    dup_articles = 0
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        check_headers(reader.fieldnames,
                      ['Код товара', 'Наименование', 'ШК товара'], csv_path)
        for row in reader:
            article = (row.get('Код товара') or '').strip()
            name = (row.get('Наименование') or '').strip()
            barcode = (row.get('ШК товара') or '').strip()
            if not (article and barcode):
                continue
            # P1-7: дубли артикулов считаем и показываем, а не глотаем молча
            if article in products:
                dup_articles += 1
                if dup_articles <= 10:
                    print(f'ВНИМАНИЕ: дубль артикула {article!r} (оставлен первый)')
                continue
            products[article] = {
                'article': article,
                'name': name,
                'barcode': barcode
            }

    now = datetime.now(timezone.utc)
    version = now.strftime('%Y%m%d%H%M%S')
    updated_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')

    os.makedirs(os.path.dirname(json_path), exist_ok=True)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({
            'version': version,
            'updatedAt': updated_at,
            'products': list(products.values())
        }, f, ensure_ascii=False, indent=2)

    print(f'Converted {len(products)} products to {json_path}')
    print(f'Version: {version} | Updated: {updated_at}')
    if dup_articles:
        print(f'ВНИМАНИЕ: дублей артикулов пропущено: {dup_articles}')

def find_input(pattern):
    matches = glob.glob(os.path.join(os.getcwd(), pattern))
    if not matches:
        raise SystemExit(
            f'Файл не найден по шаблону {pattern!r} (запускайте из корня репозитория: {os.getcwd()})'
        )
    return max(matches, key=os.path.getmtime)

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    convert_csv_to_json(
        os.path.join(root_dir, 'warehouse_data.csv'),
        os.path.join(root_dir, 'data', 'shelves.json')
    )
    convert_products_to_json(
        find_input('Остатки S187 *.csv'),
        os.path.join(root_dir, 'data', 'products.json')
    )
