import csv
import json
import os
from datetime import datetime, timezone

def parse_main_cell(name, barcode):
    parts = name.split('-')
    if len(parts) == 1:
        return None
    section = parts[0]
    second = parts[1]
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
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            code = row['Код зоны']
            cell = row['Ячейка']
            barcode = row['ШК']
            if code == 'Main':
                shelf = parse_main_cell(cell, barcode)
                if shelf:
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

def convert_products_to_json(csv_path, json_path):
    products = {}
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            article = row['Код товара'].strip()
            name = row['Наименование'].strip()
            barcode = row['ШК товара'].strip()
            if article and barcode and article not in products:
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

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    convert_csv_to_json(
        os.path.join(root_dir, 'warehouse_data.csv'),
        os.path.join(root_dir, 'data', 'shelves.json')
    )
    convert_products_to_json(
        os.path.join(root_dir, 'Остатки S187 2026-07-05_00-11-43.csv'),
        os.path.join(root_dir, 'data', 'products.json')
    )
