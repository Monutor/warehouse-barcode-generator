import csv
import json
import os
from datetime import datetime, timezone

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

    now = datetime.now(timezone.utc)
    version = now.strftime('%Y%m%d%H%M%S')
    updated_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')

    js_content = (
        f'// Data version: {version} | Updated: {updated_at}\n'
        f'const DATA_VERSION = "{version}";\n'
        f'const DATA_UPDATED_AT = "{updated_at}";\n'
        f'const SHELVES = ' + json.dumps(shelves, ensure_ascii=False, indent=2) + ';\n'
    )

    os.makedirs(os.path.dirname(js_path), exist_ok=True)
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)

    print(f'Converted {len(shelves)} shelves to {js_path}')
    print(f'Version: {version} | Updated: {updated_at}')

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    csv_path = os.path.join(root_dir, 'warehouse_data.csv')
    js_path = os.path.join(root_dir, 'data', 'shelves.js')
    convert_csv_to_js(csv_path, js_path)
