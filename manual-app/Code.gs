/**
 * みらい歯科 院内マニュアル — Googleスプレッドシート版サーバー
 *
 * index.html をウェブアプリとして配信し、マニュアル・スタッフ・進み具合を
 * スプレッドシートに保存します。index.html 内の体験モード（LocalServer）と同じ動きです。
 */

const SHEET_DEFS = {
  manuals: ['id', 'json', 'updatedAt'],
  staff: ['id', 'name', 'role'],
  progress: ['staffId', 'manualId', 'json', 'updatedAt']
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('みらい歯科 院内マニュアル')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ---------- スプレッドシート ---------- */

function props_() {
  return PropertiesService.getScriptProperties();
}

// データ用のスプレッドシート（初回は自動で作成）
function book_() {
  const id = props_().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('みらい歯科 院内マニュアル データ');
  props_().setProperty('SHEET_ID', ss.getId());
  return ss;
}

function sheet_(name) {
  const ss = book_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEET_DEFS[name].length).setValues([SHEET_DEFS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    const first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
    if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  }
  return sh;
}

function rows_(name) {
  const sh = sheet_(name);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, SHEET_DEFS[name].length).getValues();
}

function writeAll_(name, values) {
  const sh = sheet_(name);
  const cols = SHEET_DEFS[name].length;
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols).clearContent();
  if (values.length) sh.getRange(2, 1, values.length, cols).setValues(values);
}

// keyCols 列の値が一致する行を置き換え、なければ追加する（prepend: 先頭に追加）
function upsert_(name, keyCols, row, prepend) {
  const sh = sheet_(name);
  const data = rows_(name);
  const idx = data.findIndex(r => keyCols.every(c => String(r[c]) === String(row[c])));
  if (idx >= 0) {
    sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  } else if (prepend && data.length) {
    sh.insertRowBefore(2);
    sh.getRange(2, 1, 1, row.length).setValues([row]);
  } else {
    sh.getRange(data.length + 2, 1, 1, row.length).setValues([row]);
  }
}

function removeWhere_(name, test) {
  const data = rows_(name);
  const kept = data.filter(r => !test(r));
  if (kept.length !== data.length) writeAll_(name, kept);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 暗証番号 ---------- */

const PIN_KEYS = { edit: 'EDIT_PIN', admin: 'ADMIN_PIN' };

function pinOf_(kind) {
  return props_().getProperty(PIN_KEYS[kind]) || '';
}

function check_(kind, pin) {
  const set = pinOf_(kind);
  if (set && set !== String(pin || '')) throw new Error('PIN');
}

/* ---------- 画面から呼ばれる関数 ---------- */

function getAll() {
  const progress = {};
  rows_('progress').forEach(r => {
    (progress[r[0]] = progress[r[0]] || {})[r[1]] = JSON.parse(r[2]);
  });
  return {
    manuals: rows_('manuals').map(r => JSON.parse(r[1])),
    staff: rows_('staff').map(r => ({ id: String(r[0]), name: String(r[1]), role: String(r[2]) })),
    progress: progress,
    hasEditPin: !!pinOf_('edit'),
    hasAdminPin: !!pinOf_('admin'),
    initialized: props_().getProperty('INITIALIZED') === '1'
  };
}

// 初回だけ、サンプルのマニュアルを登録する
function initialize(list) {
  return withLock_(() => {
    if (props_().getProperty('INITIALIZED') === '1') return false;
    writeAll_('manuals', list.map(m => [m.id, JSON.stringify(m), new Date().toISOString()]));
    sheet_('staff');
    sheet_('progress');
    props_().setProperty('INITIALIZED', '1');
    return true;
  });
}

function verifyPin(kind, pin) {
  const set = pinOf_(kind);
  return !set || set === String(pin || '');
}

function setPin(kind, adminPin, next) {
  if (!PIN_KEYS[kind]) throw new Error('KIND');
  check_('admin', adminPin);
  if (next && !/^\d{4}$/.test(String(next))) throw new Error('FORMAT');
  if (next) props_().setProperty(PIN_KEYS[kind], String(next));
  else props_().deleteProperty(PIN_KEYS[kind]);
  return true;
}

function saveManual(m, updates, editPin) {
  check_('edit', editPin);
  return withLock_(() => {
    const now = new Date().toISOString();
    upsert_('manuals', [0], [m.id, JSON.stringify(m), now], true);
    Object.keys(updates || {}).forEach(sid => {
      upsert_('progress', [0, 1], [sid, m.id, JSON.stringify(updates[sid]), now]);
    });
    return true;
  });
}

function deleteManual(id, editPin) {
  check_('edit', editPin);
  return withLock_(() => {
    removeWhere_('manuals', r => String(r[0]) === String(id));
    removeWhere_('progress', r => String(r[1]) === String(id));
    return true;
  });
}

function saveProgress(staffId, manualId, rec) {
  return withLock_(() => {
    if (!rows_('staff').some(r => String(r[0]) === String(staffId))) throw new Error('STAFF');
    upsert_('progress', [0, 1], [staffId, manualId, JSON.stringify(rec), new Date().toISOString()]);
    return true;
  });
}

function saveStaff(list, adminPin) {
  check_('admin', adminPin);
  return withLock_(() => {
    writeAll_('staff', list.map(s => [s.id, s.name, s.role || '']));
    const ids = {};
    list.forEach(s => { ids[s.id] = true; });
    removeWhere_('progress', r => !ids[r[0]]);
    return true;
  });
}

function replaceManuals(list, adminPin) {
  check_('admin', adminPin);
  return withLock_(() => {
    const now = new Date().toISOString();
    writeAll_('manuals', list.map(m => [m.id, JSON.stringify(m), now]));
    const ids = {};
    list.forEach(m => { ids[m.id] = true; });
    removeWhere_('progress', r => !ids[r[1]]);
    return true;
  });
}
