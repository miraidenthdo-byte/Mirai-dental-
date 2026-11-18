# プレゼント（配布）版を作る：python3 data/make-gift.py
# index.html から、パスワード類・医院名・先生のお名前を伏せたコピーを gift/ に作る。
# Code.gs と appsscript.json は同じものをコピーする。
import re, shutil, subprocess, sys, os
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
s = open(os.path.join(root, 'index.html'), encoding='utf-8').read()
REPLACE = [
    ('→「F12」→「1107」→enter', '→「F12」→「（院内のログイン番号）」→enter'),
    ('ID…admini　PW…3263', 'ID・パスワードは院内で確認してください'),
    ('（青山先生：Align123／院長先生：Mirai1107）', ''),
    ('みらい歯科・矯正歯科', '〇〇歯科'),
    ('青山先生', '〇〇先生'),
    ('岩田先生', '〇〇先生'),
    ('Dr岩田', 'Dr〇〇'),
]
for a, b in REPLACE:
    if a not in s: sys.exit('見つかりません: ' + a)
    s = s.replace(a, b)
# みらい歯科のNotionページへのリンク（相手は開けない）を外す
import json
def strip_notion(line):
    if not line.startswith('    {"id":"n-'): return line
    body = line.rstrip()
    comma = body.endswith(',')
    m = json.loads(body.rstrip(','))
    m.pop('source', None)
    for st in m['steps']:
        if 'links' in st:
            st['links'] = [x for x in st['links'] if 'notion.com' not in x.get('url', '')]
            if not st['links']: del st['links']
    return '    ' + json.dumps(m, ensure_ascii=False, separators=(',', ':')) + (',' if comma else '')
s = '\n'.join(strip_notion(l) for l in s.split('\n'))
for bad in ['app.notion.com', '1107', 'admini', '3263', 'Align123', 'Mirai1107', 'みらい歯科', '青山', '岩田']:
    hits = [l[:80] for l in s.split('\n') if bad in l and not l.lstrip().startswith('//')]
    if hits: sys.exit('まだ残っています: ' + bad + ' ' + str(hits[:2]))
out = os.path.join(root, 'gift'); os.makedirs(out, exist_ok=True)
open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(s)
for f in ['Code.gs', 'appsscript.json']: shutil.copy(os.path.join(root, f), os.path.join(out, f))
subprocess.run([sys.executable, os.path.join(here, 'fix-diag.py'), os.path.join(out, 'index.html')], check=True)
print('gift/ を作りました')
