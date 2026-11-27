// Notion連携の模擬テスト（Notion API を偽物に置き換えて実行）：node data/test-notion.js Code.gs
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const conv = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x)) ? new Date(x) : x;
function Sheet(name) { this.name = name; this.d = []; }
Sheet.prototype = {
  getLastRow() { return this.d.length; },
  appendRow(row) { this.d.push(row.map(conv)); },
  getRange(r, c, nr, nc) { const sh = this; nr = nr || 1; nc = nc || 1; return {
    setValues(v) { v.forEach((row, i) => { sh.d[r - 1 + i] = sh.d[r - 1 + i] || []; row.forEach((x, j) => sh.d[r - 1 + i][c - 1 + j] = conv(x)); }); return this; },
    setValue(x) { sh.d[r - 1][c - 1] = conv(x); return this; },
    getValues() { return sh.d.slice(r - 1, r - 1 + nr).map(row => Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? '')); },
    clearContent() { sh.d.splice(r - 1, nr); return this; }, setFontWeight() { return this; } }; },
  setFrozenRows() {}, insertRowBefore(r) { this.d.splice(r - 1, 0, []); }
};
const ss = { sheets: [new Sheet('シート1')], getId: () => 'X', getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; },
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }, getSheets() { return this.sheets; }, deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); } };
const P = {}, C = {};

// ---- 偽物の Notion ----
const KEY = 'ntn_' + 'a'.repeat(40);
const hex = () => crypto.randomBytes(16).toString('hex');
const SRC = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', PARENT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', HIDDEN = 'cccccccccccccccccccccccccccccccc';
const N = { pages: {}, blocks: {}, calls: [], fail: null };
const mkPage = (id, title, shared, parent) => { N.pages[id] = { id, title, shared, archived: false, parent, children: [] }; };
mkPage(SRC, '朝の準備', true); mkPage(PARENT, 'アプリから追加', true); mkPage(HIDDEN, '見えない', false);
// 元ページ：普通のブロック2つ＋サブページ1つ
N.pages[SRC].children = ['b1', 'sub1', 'b2'];
N.blocks = { b1: { id: 'b1', type: 'paragraph' }, sub1: { id: 'sub1', type: 'child_page' }, b2: { id: 'b2', type: 'bulleted_list_item' } };
function notion(method, path, body, auth) {
  N.calls.push(method + ' ' + path);
  const R = (code, json) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(json || {}) });
  if (auth !== 'Bearer ' + KEY) return R(401, { code: 'unauthorized' });
  if (N.fail && N.fail(method, path)) return R(500, { code: 'internal' });
  let m;
  if (path === '/users/me') return R(200, { name: 'マニュアル連携', bot: { workspace_name: '院内Wiki' } });
  if ((m = path.match(/^\/pages\/(\w+)$/))) {
    const p = N.pages[m[1]];
    if (!p || !p.shared) return R(404, { code: 'object_not_found' });
    if (method === 'get') return R(200, { id: p.id, archived: p.archived, properties: { 名前: { type: 'title', title: [{ plain_text: p.title }] } } });
    if (body.archived) p.archived = true;
    if (body.properties) p.title = body.properties['名前'].title.map(t => t.text.content).join('');
    return R(200, { id: p.id });
  }
  if (path.startsWith('/databases/')) return R(404, { code: 'object_not_found' });
  if (path === '/pages' && method === 'post') {
    const par = N.pages[body.parent.page_id];
    if (!par || !par.shared) return R(404, { code: 'object_not_found' });
    const id = hex();
    mkPage(id, body.properties.title.title.map(t => t.text.content).join(''), true, body.parent.page_id);
    (body.children || []).forEach(b => { const bid = hex(); N.blocks[bid] = Object.assign({ id: bid }, b); N.pages[id].children.push(bid); });
    return R(200, { id: id.replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/, '$1-$2-$3-$4-$5') });
  }
  if ((m = path.match(/^\/blocks\/(\w+)\/children/))) {
    const p = N.pages[m[1]];
    if (!p || !p.shared) return R(404, { code: 'object_not_found' });
    if (method === 'get') return R(200, { results: p.children.map(id => N.blocks[id]), has_more: false });
    if (body.children.length > 100) return R(400, { code: 'validation_error' });
    body.children.forEach(b => { const bid = hex(); N.blocks[bid] = Object.assign({ id: bid }, b); p.children.push(bid); });
    return R(200, {});
  }
  if ((m = path.match(/^\/blocks\/(\w+)$/)) && method === 'delete') {
    Object.values(N.pages).forEach(p => { p.children = p.children.filter(x => x !== m[1]); });
    return R(200, {});
  }
  return R(400, { code: 'unknown ' + method + ' ' + path });
}
const ctx = { SpreadsheetApp: { create: () => ss, openById: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => P[k] ?? null, setProperty: (k, v) => { P[k] = String(v); }, deleteProperty: k => { delete P[k]; } }) },
  CacheService: { getScriptCache: () => ({ get: k => C[k] ?? null, put: (k, v) => { C[k] = v; } }) },
  Utilities: { formatDate: () => '2026/11/27 12:00', getUuid: () => crypto.randomUUID(), sleep() {}, DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
    computeDigest: (_, s) => [...crypto.createHash('sha256').update(s).digest()].map(b => b > 127 ? b - 256 : b) },
  UrlFetchApp: { fetch(url, o) {
    if (!url.startsWith('https://api.notion.com/v1')) throw new Error('unexpected ' + url);
    return notion(o.method, url.slice('https://api.notion.com/v1'.length), o.payload ? JSON.parse(o.payload) : null, o.headers.Authorization);
  } },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/X/exec' }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, HtmlService: {}, console, Date };
vm.createContext(ctx); vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);
const call = (n, ...a) => JSON.parse(JSON.stringify(vm.runInContext(n, ctx)(...JSON.parse(JSON.stringify(a))) ?? null));
const throws = (re, fn) => { try { fn(); } catch (e) { return re.test(e.message); } return false; };
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok', m); };
const longText = 'あ'.repeat(4500);

call('initialize', [
  { id: 'm1', cat: 'open', title: '朝の準備', source: 'https://app.notion.com/p/' + SRC + '?pvs=204', steps: [{ h: '受付', t: 'PCをつける', tip: 'こまめに', img: ['https://example.com/a.jpg'] }] },
  { id: 'm2', cat: 'rules', title: '見えないページ', source: 'https://www.notion.so/Title-' + HIDDEN, steps: [] }
]);
const A = call('adminSetup', '1111', 'Mac').token;
const s1 = call('addStaff', A, '田中', '衛生士'); const T = call('login', s1.code, 'x').token;

ok(call('saveManual', T, { id: 'm1', cat: 'open', title: '朝の準備', source: 'https://app.notion.com/p/' + SRC, steps: [] }, null, '') === true && N.calls.length === 0, 'off: nothing sent, nothing queued');
ok(throws(/ADMINAUTH/, () => call('setNotion', T, KEY, PARENT)), 'staff cannot set key');
ok(throws(/FORMAT_KEY/, () => call('setNotion', A, 'hello', PARENT)), 'bad key rejected');
ok(throws(/FORMAT_PARENT/, () => call('setNotion', A, KEY, 'https://example.com/')), 'bad parent rejected');
let info = call('setNotion', A, 'ntn_wrong' + 'b'.repeat(30), 'https://www.notion.so/xx/アプリから追加-' + PARENT + '?v=1');
ok(info.key && !info.on && info.parent.endsWith(PARENT), 'saved key + parent');
ok(!JSON.stringify(call('adminData', A)).includes('ntn_'), 'key never returned');
let chk = call('notionCheck', A);
ok(!chk.ready && chk.checks[0].id === 'key' && !chk.checks[0].ok && /鍵が正しくありません/.test(chk.checks[0].detail), 'wrong key detected');
ok(throws(/NOTION_CHECK/, () => call('notionStart', A, [1, 1, 1, 1, 1])), 'cannot start before check passes');
call('setNotion', A, KEY, PARENT);
chk = call('notionCheck', A);
const src = chk.checks.find(c => c.id === 'source');
ok(!chk.ready && chk.checks.find(c => c.id === 'key').ok && chk.checks.find(c => c.id === 'parent').ok && chk.checks.find(c => c.id === 'write').ok, 'key/parent/write ok');
ok(!src.ok && /見えないページ/.test(src.detail) && !/朝の準備/.test(src.detail), 'unshared source page reported');
ok(Object.values(N.pages).some(p => p.title.startsWith('連携テスト') && p.archived), 'write test page archived');
N.pages[HIDDEN].shared = true;
chk = call('notionCheck', A);
ok(chk.ready && chk.stats.total === 2 && chk.stats.linked === 2, 'all checks pass');
ok(throws(/NOTION_CONFIRM/, () => call('notionStart', A, [1, 1, 1, 1])), 'all confirmations required');
ok(throws(/ADMINAUTH/, () => call('notionStart', T, [1, 1, 1, 1, 1])), 'staff cannot start');
info = call('notionStart', A, [1, 1, 1, 1, 1]);
ok(info.on, 'sync on');

// 更新：元ページの中身を入れ替え、サブページは残す
N.calls = [];
ok(call('saveManual', T, { id: 'm1', cat: 'open', title: '朝の準備（改）', summary: '要約', source: 'https://app.notion.com/p/' + SRC,
  steps: [{ h: '受付', t: 'PCをつける', say: 'おはようございます', warn: '注意', img: ['https://example.com/a.jpg', 'data:x'], media: [{ id: 'd1', type: 'image' }], links: [{ label: 'リンク', url: 'https://example.com' }, { label: 'bad', url: 'javascript:1' }] }, { t: longText }] }, null, '') === 'notion', 'save queued');
ok(N.calls.length === 0, 'save itself does not call Notion');
ok(call('adminData', A).notion.pending === 1, 'pending shown');
let r = call('notionFlush', T);
ok(r.done === 1 && r.left === 0 && r.errors === 0, 'flush ok');
const pg = N.pages[SRC];
ok(pg.title === '朝の準備（改）', 'title updated');
ok(pg.children.includes('sub1') && !pg.children.includes('b1') && !pg.children.includes('b2'), 'old blocks removed, sub page kept');
const types = pg.children.map(id => N.blocks[id].type);
ok(types.includes('callout') && types.includes('heading_3') && types.includes('quote') && types.filter(t => t === 'image').length === 1 && types.filter(t => t === 'bulleted_list_item').length === 1, 'blocks built (bad urls skipped)');
const big = pg.children.map(id => N.blocks[id]).find(b => b.type === 'paragraph' && b.paragraph.rich_text.length > 2);
ok(big && big.paragraph.rich_text.every(x => x.text.content.length <= 2000), 'long text split');
ok(JSON.stringify(pg.children.map(id => N.blocks[id])).includes('?m=m1'), 'app link included');
ok(call('adminData', A).notion.recent[0].title === '朝の準備（改）', 'recent shows result');

// 新規：追加先に作る。2回目の保存は同じページを更新（重複しない）
call('saveManual', A, { id: 'm3', cat: 'rules', title: '新しいマニュアル', steps: Array.from({ length: 120 }, (_, i) => ({ t: '手順' + i })) }, null, '');
call('notionFlush', T);
let made = Object.values(N.pages).filter(p => p.title === '新しいマニュアル');
ok(made.length === 1 && made[0].parent === PARENT && made[0].children.length > 120, 'new page created under parent (>100 blocks)');
call('saveManual', A, { id: 'm3', cat: 'rules', title: '新しいマニュアル', steps: [{ t: '1つだけ' }] }, null, '');
call('notionFlush', T);
made = Object.values(N.pages).filter(p => p.title === '新しいマニュアル');
ok(made.length === 1 && made[0].children.length < 10, 'second save updates same page');

// 削除：ページをゴミ箱へ
ok(call('deleteManual', T, 'm3', '') === 'notion', 'delete queued');
call('notionFlush', T);
ok(made[0].archived, 'deleted page archived');
call('deleteManual', T, 'm2', ''); call('notionFlush', T);
ok(N.pages[HIDDEN].archived, 'delete of imported page archives its source');

// 失敗：未反映として残し、保存は成功。やり直しで反映
N.fail = (m, p) => p.startsWith('/blocks/');
ok(call('saveManual', T, { id: 'm1', cat: 'open', title: '朝の準備', source: 'https://app.notion.com/p/' + SRC, steps: [{ t: 'x' }] }, null, '') === 'notion', 'save ok while Notion failing');
r = call('notionFlush', T);
info = call('adminData', A).notion;
ok(r.errors === 1 && info.errors.length === 1 && /NOTION_500/.test(info.errors[0].message), 'error recorded');
N.fail = null;
r = call('notionRetry', A);
ok(r.done === 1 && call('adminData', A).notion.errors.length === 0, 'retry fixes it');
ok(throws(/ADMINAUTH/, () => call('notionRetry', T)), 'staff cannot retry');

// 止める
info = call('notionStop', A, false);
N.calls = [];
ok(!info.on && info.key && call('saveManual', T, { id: 'm1', cat: 'open', title: 'x', steps: [] }, null, '') === true && N.calls.length === 0, 'stop: no more sync');
info = call('notionStop', A, true);
ok(!info.key && !P.NOTION_KEY, 'forget key');
