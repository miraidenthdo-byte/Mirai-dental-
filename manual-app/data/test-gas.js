// Code.gs の模擬テスト（Googleのサービスを偽物に置き換えて実行）：node data/test-gas.js Code.gs
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
const P = {}, C = {}, SENT = []; let RESP = 200;
const ctx = { SpreadsheetApp: { create: () => ss, openById: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => P[k] ?? null, setProperty: (k, v) => { P[k] = v; }, deleteProperty: k => { delete P[k]; } }) },
  CacheService: { getScriptCache: () => ({ get: k => C[k] ?? null, put: (k, v) => { C[k] = v; } }) },
  Utilities: { formatDate: () => '11月15日 12:00', getUuid: () => crypto.randomUUID(), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
    computeDigest: (_, s) => [...crypto.createHash('sha256').update(s).digest()].map(b => b > 127 ? b - 256 : b) },
  UrlFetchApp: { fetch(url, o) { SENT.push({ url, o }); return { getResponseCode: () => RESP, getContentText: () => RESP === 200 ? 'ok' : 'invalid_token' }; } },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/X/exec' }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }, HtmlService: {}, console, Date };
vm.createContext(ctx); vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);
const call = (n, ...a) => JSON.parse(JSON.stringify(vm.runInContext(n, ctx)(...JSON.parse(JSON.stringify(a))) ?? null));
const throws = (re, fn) => { try { fn(); } catch (e) { return re.test(e.message); } return false; };
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok', m); };
const HOOK = 'https://hooks.slack.com/services/T000/B000/abcDEF123';
call('initialize', [{ id: 'm1', title: 'A', steps: [] }]);
const A = call('adminSetup', '1111', 'Mac').token;
const s1 = call('addStaff', A, '田中', '衛生士'); const T = call('login', s1.code, 'x').token;
call('saveManual', T, { id: 'm9', cat: 'assist', title: 'X', steps: [] }, null, '');
ok(SENT.length === 0 && call('adminData', A).slack === false, 'no Slack when unset');
ok(throws(/FORMAT/, () => call('setSlack', A, 'https://evil.example.com/hook')), 'non-Slack URL rejected');
ok(throws(/ADMINAUTH/, () => call('setSlack', T, HOOK)), 'staff cannot set Slack');
call('setSlack', A, HOOK);
ok(call('adminData', A).slack === true && !JSON.stringify(call('adminData', A)).includes('abcDEF'), 'slack on, URL not returned');
ok(!JSON.stringify(call('getAll', T)).includes('abcDEF'), 'URL not in staff data');
call('testSlack', A); ok(SENT.length === 1 && SENT[0].url === HOOK, 'test sent to webhook');
call('saveManual', T, { id: 'm9', cat: 'assist', title: 'X<2>&', steps: [] }, null, '');
let msg = JSON.parse(SENT[1].o.payload).text; console.log(msg);
ok(/更新/.test(msg) && /田中さん/.test(msg) && /診療補助/.test(msg) && /X&lt;2&gt;&amp;/.test(msg) && /\?m=m9\|アプリで開く>/.test(msg), 'update notify');
call('saveManual', A, { id: 'm10', cat: 'rules', title: 'New', steps: [] }, null, '');
ok(/追加/.test(JSON.parse(SENT[2].o.payload).text) && /管理者/.test(JSON.parse(SENT[2].o.payload).text), 'add notify');
call('deleteManual', T, 'm10', '');
msg = JSON.parse(SENT[3].o.payload).text; ok(/削除/.test(msg) && /New/.test(msg) && !/アプリで開く/.test(msg), 'delete notify');
RESP = 403; ok(call('saveManual', T, { id: 'm9', title: 'X3', steps: [] }, null, '') === true, 'save ok even if Slack fails');
ok(throws(/SLACK_403/, () => call('testSlack', A)), 'test reports Slack error');
call('setSlack', A, ''); ok(call('adminData', A).slack === false, 'slack off');
