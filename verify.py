import json

with open('data/shelves.js', 'r', encoding='utf-8') as f:
    data = f.read()

arr = json.loads(data.replace('const SHELVES = ', '').rstrip(';'))
print(f'Count: {len(arr)}')
print(f'Keys: {list(arr[0].keys())}')
null_levels = sum(1 for e in arr if e['level'] is None)
string_levels = sum(1 for e in arr if e['level'] is not None)
print(f'Null levels: {null_levels}')
print(f'String levels: {string_levels}')
print(f'Starts with const SHELVES = [: {data.startswith("const SHELVES = [")}')
print(f'Ends with ];: {data.rstrip().endswith("];")}')
