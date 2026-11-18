# index.html を直したあとに必ず実行する：python3 data/fix-diag.py index.html
# ・<script> 内に「/*」「*/」が無いことを確認（Apps Script は配信時にこれをコメントとみなして削除するため）
# ・読み込みエラー時の診断表示（正しい長さ・行数・行ごとのハッシュ）を今の中身に合わせて更新
import re,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
for sc in re.findall(r'<script>(.*?)</script>',s,re.S): assert '/*' not in sc and '*/' not in sc, 'comment-like /* in script'
L=s.split('\n')
start=[i+1 for i,l in enumerate(L) if l=='<script>'][1]
baseline=[i+1 for i,l in enumerate(L) if "throw new Error('x')" in l][0]
s=re.sub(r"e\.lineno - \(__base - \d+\)",f"e.lineno - (__base - {baseline})",s)
s=re.sub(r"lines\[row - \d+\]",f"lines[row - {start}]",s)
s=re.sub(r"\(k \+ \d+\) \+ '行目",f"(k + {start}) + '行目",s)
mainc=[x for x in re.findall(r'<script>(.*?)</script>',s,re.S) if 'DEFAULT_MANUALS =' in x][0]
def hs(x):
  h=7
  for ch in x:
    o=ord(ch)
    for cu in ([o] if o<0x10000 else [0xD800+((o-0x10000)>>10),0xDC00+((o-0x10000)&0x3FF)]): h=(h*31+cu)%1296
  d='0123456789abcdefghijklmnopqrstuvwxyz'; t=(d[h//36] if h>=36 else '')+d[h%36]; return ('0'+t)[-2:]
H=''.join(hs(l) for l in mainc.split('\n'))
s=re.sub(r"var H = '[0-9a-z]*'",f"var H = '{H}'",s)
n16=sum(2 if ord(c)>0xFFFF else 1 for c in mainc)
s=re.sub(r"正しい長さ \d+・行数 ' \+ lines.length \+ ' / \d+",f"正しい長さ {n16}・行数 ' + lines.length + ' / {len(mainc.split(chr(10)))}",s)
open(p,'w',encoding='utf-8').write(s); print('diag updated',start,baseline,n16)
